import puppeteer from "puppeteer";
import readline from "readline";
import axios from "axios";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .option("email", {
    alias: "e",
    type: "string",
    description: "Login email",
    demandOption: true,
  })
  .option("password", {
    alias: "p",
    type: "string",
    description: "Login password",
    demandOption: true,
  })
  .option("phillips_account_id", {
    alias: "pa",
    type: "Number",
    description: "Phillips Account ID in the system",
    demandOption: true,
  })
  .option("auction_session_id", {
    alias: "a",
    type: "Number",
    description: "Auction Session ID",
    demandOption: true,
  })
  .help()
  .alias("help", "h").argv;

class AuctionSniper {
  constructor() {
    this.browser = null;
    this.mainPage = null;
    this.tabs = [];
    this.loggedIn = false;
    this.vehicleData = []; // Store vehicle data for increment calculations
  }

  async init() {
    this.browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true, // Set to true in production
      args: ["--no-sandbox"],
    });
    this.mainPage = await this.browser.newPage();
  }

  async login() {
    console.log("Logging in...");
    await this.mainPage.goto("https://phillipsauctioneers.co.ke/my-account", {
      waitUntil: "networkidle2",
      timeout: 600000,
    });

    await this.mainPage.type("#username", argv.email);
    await this.mainPage.type("#password", argv.password);
    await this.mainPage.click('[name="login"]');
    await this.mainPage.waitForNavigation({ waitUntil: "networkidle2" });

    this.loggedIn = true;
    console.log("Login successful!");
  }

  async prepareTabs(vehicleData) {
    if (!this.loggedIn) throw new Error("Not logged in");
    this.vehicleData = vehicleData; // Store for later reference

    console.log(`Preparing ${vehicleData.length} tabs...`);
    for (let i = 0; i < vehicleData.length; i++) {
      const tab = await this.browser.newPage();

      // Copy cookies from main page to new tab
      const cookies = await this.mainPage.cookies();
      await tab.setCookie(...cookies);

      await tab.goto(vehicleData[i].url, { waitUntil: "networkidle2" });

      const initialAmount =
        vehicleData[i].current_bid + vehicleData[i].sniping_stage_increment;

      // Prepare bid amount but don't submit yet
      await tab.focus("#_actual_bid");
      await tab.keyboard.down("Control");
      await tab.keyboard.press("A");
      await tab.keyboard.up("Control");
      await tab.keyboard.press("Backspace");
      await tab.type("#_actual_bid", initialAmount.toString(), {
        delay: 100,
      });
      await tab.focus(".ywcact-auction-confirm");
      await tab.keyboard.press("Enter");

      this.tabs.push({
        page: tab,
        url: vehicleData[i].url,
        id: vehicleData[i].id,
        amount: initialAmount,
        maxAmount: vehicleData[i].maximum_amount,
        increment: vehicleData[i].sniping_stage_increment,
        retries: 0, // Track number of retry attempts
        ready: true,
      });

      console.log(`Tab ${i + 1} ready with amount ${initialAmount}`);
    }
  }

  async triggerBids() {
    // Fetch latest vehicle data from API
    const response = await axios.post(
      "http://127.0.0.1:80/api/sniping/init",
      {
        auction_session_id: argv.auction_session_id,
        phillips_account_id: argv.phillips_account_id,
      }
    );

    const latestVehicleData = response.data;
    console.log(`Fetched ${latestVehicleData.length} active vehicles`);

    const tabsToTrigger = this.tabs.filter((tab) =>
      latestVehicleData.some((vehicle) => vehicle.id === tab.id)
    );

    if (tabsToTrigger.length === 0) {
      console.log("No matching tabs found for the provided IDs");
      return;
    }

    for (const tab of tabsToTrigger) {
      if (!tab.ready) continue;

      try {
        await tab.page.bringToFront();
        await new Promise((r) => setTimeout(r, 100)); // Small delay for stability

        console.log(
          `Processing tab: (${await tab.id}) ${await tab.page.title()}`
        );

        const buttons = await tab.page.$$(".ywcact-modal-button-confirm-bid");
        if (buttons.length < 2) throw new Error("Second button missing!");

        await buttons[1].click({ delay: 100 });

        // Wait for success/error message
        try {
          await tab.page.waitForFunction(
            () => {
              const errorMsg = document.querySelector("ul.woocommerce-error");
              const successMsg = document.querySelector(
                "div.woocommerce-message"
              );
              return errorMsg || successMsg;
            },
            { timeout: 10000 }
          );

          // Check for error
          const errorElement = await tab.page.$("ul.woocommerce-error");
          if (errorElement) {
            const errorMessage = await tab.page.$eval(
              "ul.woocommerce-error li",
              (el) => el.textContent.trim()
            );
            throw new Error(errorMessage);
          }

          // Success case
          const successElement = await tab.page.$("div.woocommerce-message");
          if (successElement) {
            const successMessage = await tab.page.$eval(
              "div.woocommerce-message",
              (el) => el.textContent.trim()
            );
            console.log(`✅ Bid successful: ${successMessage}`);
            tab.ready = false;
          }
        } catch (err) {
          if (err.name === "TimeoutError") {
            console.log("ℹ️ No confirmation message detected");
          } else {
            throw err; // Re-throw other errors
          }
        }
      } catch (error) {
        console.error(`❌ Bid failed on ${tab.url}:`, error.message);

        // Auto-retry with higher bid if error suggests it
        if (
          error.message.toLowerCase().includes("higher") ||
          error.message.toLowerCase().includes("increase")
        ) {
          tab.retries += 1;
          const newIncrement = tab.increment * (tab.retries + 1);
          const newAmount = tab.amount + newIncrement;

          console.log(
            `Trial ${tab.retries} increment now is ${newIncrement}, thus the amount is ${newAmount}`
          );
          // Don't exceed maximum allowed bid
          if (newAmount > tab.maxAmount) {
            console.log(
              `⚠️ Cannot increase bid further (max: ${tab.maxAmount}, attempted: ${newAmount})`
            );
            tab.ready = false;
            continue;
          }

          console.log(
            `🔄 Retry #${tab.retries}: Increasing bid from ${tab.amount} to ${newAmount}`
          );

          // Update bid amount
          tab.amount = newAmount;

          // Re-enter the bid
          await tab.page.focus("#_actual_bid");
          await tab.page.keyboard.down("Control");
          await tab.page.keyboard.press("A");
          await tab.page.keyboard.up("Control");
          await tab.page.keyboard.press("Backspace");
          await tab.page.type("#_actual_bid", tab.amount.toString(), {
            delay: 100,
          });

          // Re-trigger the bid
          await this.triggerBids(); // Recursively retry
        } else {
          console.log("⚠️ Non-bid-related error, skipping retry");
          await tab.page.screenshot({ path: `error-${Date.now()}.png` });
        }
      }
    }
  }

  async close() {
    await this.browser.close();
  }
}

// Main execution
(async () => {
  const sniper = new AuctionSniper();
  await sniper.init();
  await sniper.login();

  // Fetch initial vehicle data
  const response = await axios.post("http://127.0.0.1:80/api/sniping/init", {
    auction_session_id: argv.auction_session_id,
    phillips_account_id: argv.phillips_account_id,
  });

  await sniper.prepareTabs(response.data);
  console.log('Type "trigger" to submit bids or "close" to exit');

  // CLI control
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("line", (input) => {
    if (input === "trigger") {
      sniper.triggerBids();
    } else if (input === "close") {
      sniper.close();
      rl.close();
    }
  });
})();
