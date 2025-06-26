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
  }

  async init() {
    this.browser = await puppeteer.launch({
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

    console.log(`Preparing ${vehicleData.length} tabs...`);
    for (let i = 0; i < vehicleData.length; i++) {
      const tab = await this.browser.newPage();

      // Copy cookies from main page to new tab
      const cookies = await this.mainPage.cookies();
      await tab.setCookie(...cookies);

      await tab.goto(vehicleData[i].url, { waitUntil: "networkidle2" });

      // Prepare bid amount but don't submit yet
      await tab.focus("#_actual_bid");
      await tab.keyboard.down("Control");
      await tab.keyboard.press("A");
      await tab.keyboard.up("Control");
      await tab.keyboard.press("Backspace");
      await tab.type("#_actual_bid", vehicleData[i].maximum_amount.toString(), {
        delay: 100,
      });
      await tab.focus(".ywcact-auction-confirm");
      await tab.keyboard.press("Enter");

      this.tabs.push({
        page: tab,
        url: vehicleData[i].url,
        id: vehicleData[i].id,
        amount: vehicleData[i].maximum_amount,
        ready: true,
      });

      console.log(
        `Tab ${i + 1} ready with amount ${vehicleData[i].maximum_amount}`
      );
    }
  }

  async triggerBids() {
    // Fetch from DB those vehicles that have yet to be won // status !== 'highest'
    const response = await axios.post(
      "http://127.0.0.1:80/api/sniping/init",
      {
        auction_session_id: argv.auction_session_id,
        phillips_account_id: argv.phillips_account_id,
      }
    );

    const vehicleData = response.data;

    console.log(response);

    console.log(vehicleData.length);

    const tabsToTrigger = this.tabs.filter((tab) =>
      vehicleData.some((triggerItem) => triggerItem.id === tab.id)
    );

    if (tabsToTrigger.length === 0) {
      console.log("No matching tabs found for the provided IDs");
      return;
    }
    for (const tab of tabsToTrigger) {
      if (!tab.ready) continue;

      try {
        await tab.page.bringToFront(); // Brings tab to focus
        await new Promise((r) => setTimeout(r, 0));

        // 2. DEBUG: Verify we're on the right tab
        console.log(`Processing tab: ${await tab.page.title()}`);

        // 3. CLICK LOGIC (now that tab is focused)
        const buttons = await tab.page.$$(".ywcact-modal-button-confirm-bid");
        if (buttons.length < 2) throw new Error("Second button missing!");

        await buttons[1].click({ delay: 10 });

        // 4. Wait for either success or error message
        // try {
        //   // Wait for potential error message
        //   const errorElement = await tab.page.waitForSelector(
        //     "ul.woocommerce-error",
        //     {
        //       timeout: 5000, // wait up to 5 seconds
        //     }
        //   );

        //   if (errorElement) {
        //     // Extract and log error message
        //     const errorMessage = await tab.page.$eval(
        //       "ul.woocommerce-error li",
        //       (el) => el.textContent.trim()
        //     );
        //     console.log("Bid Error:", errorMessage);
        //     throw new Error(errorMessage); // Optional: rethrow if you want to handle this as an error
        //   }
        // } catch (err) {
        //   // If the error element doesn't appear within timeout, continue silently
        //   // This means the bid was likely successful
        //   if (!err.message.includes("waiting for selector")) {
        //     // Only log if it's not a timeout error (which we expect for successful bids)
        //     console.log("Error checking for bid confirmation:", err.message);
        //   }
        // }

        // Wait for either error or success message
        try {
          // Wait for either message to appear (with a reasonable timeout)
          await tab.page.waitForFunction(
            () => {
              const errorMsg = document.querySelector("ul.woocommerce-error");
              const successMsg = document.querySelector(
                "div.woocommerce-message"
              );
              return errorMsg || successMsg;
            },
            { timeout: 10000 }
          ); // 10 second timeout

          // Check for error message first
          const errorElement = await tab.page.$("ul.woocommerce-error");
          if (errorElement) {
            const errorMessage = await tab.page.$eval(
              "ul.woocommerce-error li",
              (el) => el.textContent.trim()
            );
            console.log("❌ Bid Error:", errorMessage);
            throw new Error(errorMessage);
          }

          // If no error, check for success message
          const successElement = await tab.page.$("div.woocommerce-message");
          if (successElement) {
            const successMessage = await tab.page.$eval(
              "div.woocommerce-message",
              (el) => el.textContent.trim()
            );
            console.log("✅ Bid Success:", successMessage);
          }
        } catch (err) {
          if (err.name === "TimeoutError") {
            console.log(
              "ℹ️ No confirmation message detected within timeout period"
            );
          } else if (!err.message.includes("waiting for selector")) {
            console.log("Error checking bid status:", err.message);
          }
        }
        // 4. CONFIRMATION
        console.log(`✅ Bid submitted on ${tab.url}`);
        tab.ready = false;
      } catch (error) {
        console.error(`❌ Failed on ${tab.url}:`, error.message);
        await tab.page.screenshot({ path: `error-${Date.now()}.png` });
      }
    }
  }

  async close() {
    await this.browser.close();
  }
}

// Usage Example
(async () => {
  const sniper = new AuctionSniper();
  await sniper.init();

  // 1. Login (only once)
  await sniper.login();

  // Get vehicle Urls from app
  const response = await axios.post("http://127.0.0.1:80/api/sniping/init", {
    auction_session_id: argv.auction_session_id,
    phillips_account_id: argv.phillips_account_id,
  });

  const vehicleData = response.data;

  console.log(response);

  console.log(vehicleData.length);

  await sniper.prepareTabs(vehicleData);

  console.log("All tabs ready. Waiting for trigger command...");

  // 3. Set up trigger mechanism
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("line", (input) => {
    if (input === "trigger") {
      sniper.triggerBids(); // Or specify indexes: [0, 1, 2]
    } else if (input === "close") {
      sniper.close();
      process.exit();
    }
  });

  console.log('Type "trigger" to submit all bids, or "close" to exit');
})();
