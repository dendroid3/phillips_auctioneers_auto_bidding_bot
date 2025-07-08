import puppeteer from "puppeteer";
import axios from "axios";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .option("email", { alias: "e", type: "string", demandOption: true })
  .option("password", { alias: "p", type: "string", demandOption: true })
  .option("phillips_account_id", {
    alias: "pa",
    type: "number",
    demandOption: true,
  })
  .option("auction_session_id", {
    alias: "a",
    type: "number",
    demandOption: true,
  })
  .option("trigger_time", { alias: "t", type: "string", demandOption: true })
  .option("bid_stage_id", { alias: "b", type: "number", demandOption: true })
  .help()
  .alias("help", "h").argv;

class AuctionSniper {
  constructor() {
    this.browser = null;
    this.mainPage = null;
    this.tabs = [];
  }

  async init() {
    this.browser = await puppeteer.launch({
      executablePath: "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    this.mainPage = await this.browser.newPage();
    await this.mainPage.setViewport({ width: 1280, height: 800 });
  }

  async login() {
    console.log("\uD83D\uDD10 Logging in...");
    await this.mainPage.goto("https://phillipsauctioneers.co.ke/my-account", {
      waitUntil: "networkidle2",
      timeout: 600000,
    });

    await this.mainPage.type("#username", argv.email);
    await this.mainPage.type("#password", argv.password);
    await this.mainPage.click('[name="login"]');
    await this.mainPage.waitForNavigation({ waitUntil: "networkidle2" });
    console.log("\u2705 Login successful.");
  }

  async prepareTabs(vehicleData) {
    console.log(`\ud83e\uddf9 Preparing ${vehicleData.length} tabs...`);
    for (const vehicle of vehicleData) {
      const tab = await this.browser.newPage();
      const cookies = await this.mainPage.cookies();
      await tab.setCookie(...cookies);
      await tab.goto(vehicle.url, { waitUntil: "networkidle2" });

      const initialAmount = vehicle.current_bid
        ? Math.min(
            vehicle.current_bid + vehicle.sniping_stage_increment,
            vehicle.maximum_amount
          )
        : vehicle.start_amount;

      await tab.waitForSelector("#_actual_bid", { timeout: 10000 });
      await tab.click("#_actual_bid", { clickCount: 3 });
      await tab.keyboard.press("Backspace");
      await tab.keyboard.up("Backspace");
      await tab.type("#_actual_bid", initialAmount.toString(), { delay: 100 });

      const triggerBtn = await tab.$(".ywcact-auction-confirm");
      if (triggerBtn) await triggerBtn.click();

      this.tabs.push({
        id: vehicle.id,
        url: vehicle.url,
        page: tab,
        amount: initialAmount,
        maxAmount: vehicle.maximum_amount,
        increment: vehicle.sniping_stage_increment,
        retries: 0,
        ready: true,
        triggered: false,
        placedMax: initialAmount >= vehicle.maximum_amount,
        successful: false,
      });

      console.log(`\u2705 Tab ready for vehicle ${vehicle.id}`);
    }
  }

  async confirmBid(tab) {
    try {
      await tab.page.bringToFront();
      await tab.page.waitForSelector(".ywcact-auction-confirm", {
        visible: true,
      });
      await tab.page.click(".ywcact-auction-confirm", { delay: 100 });

      try {
        await tab.page.waitForFunction(
          () => {
            const modal = document.getElementById("confirmationModal");
            return modal && getComputedStyle(modal).display === "flex";
          },
          { timeout: 2000 }
        );
      } catch {}

      await tab.page.waitForSelector(".ywcact-modal-button-confirm-bid", {
        visible: true,
        timeout: 3000,
      });

      const buttons = await tab.page.$$(".ywcact-modal-button-confirm-bid");
      if (buttons.length >= 2) {
        const box = await buttons[1].boundingBox();
        if (!box) throw new Error("Confirm button not clickable");
        await buttons[1].click({ delay: 100 });
        tab.triggered = true;
        console.log(`\u2705 Confirmed bid on ${tab.id} of ${tab.amount}`);
      }
    } catch (err) {
      console.error(`\u274c Failed to confirm bid on ${tab.id}: ${err.message}`);
    }
  }

  async triggerBids() {
    const response = await axios.post(
      "http://127.0.0.1:80/api/sniping/trigger",
      {
        auction_session_id: argv.auction_session_id,
        phillips_account_id: argv.phillips_account_id,
      }
    );

    const vehiclesToTrigger = response.data;
    console.log(`\ud83d\ude80 Triggering bids for ${vehiclesToTrigger.length} vehicles...`);

    for (const vehicle of vehiclesToTrigger) {
      const tab = this.tabs.find(
        (t) => t.id === vehicle.id && t.ready && !t.triggered && !t.successful
      );
      if (!tab) continue;
      await this.confirmBid(tab);
    }

    for (const tab of this.tabs.filter((t) => t.triggered && t.ready)) {
      const errorElement = await tab.page.$("ul.woocommerce-error");
      if (errorElement) {
        const errorMessage = await tab.page.$eval(
          "ul.woocommerce-error li",
          (el) => el.textContent.trim()
        );
        console.log(`\u274c Error on ${tab.id}: ${errorMessage}`);

        if (errorMessage.toLowerCase().includes("higher")) {
          const nextBid = tab.amount + tab.increment;

          if (tab.amount >= tab.maxAmount || nextBid > tab.maxAmount) {
            console.log(`\u274c Max bid already placed on ${tab.id}`);
            tab.ready = false;
            await axios.post("http://127.0.0.1:80/api/bid/create", {
              amount: tab.amount,
              vehicle_id: tab.id,
              phillips_account_email: argv.email,
              bid_stage_id: argv.bid_stage_id,
              status: "Outbudgeted",
            });
            continue;
          }

          const newAmount = nextBid;
          console.log(`\u21ba Retrying ${tab.id} with amount ${newAmount}`);

          tab.amount = newAmount;
          tab.placedMax = newAmount >= tab.maxAmount;

          await tab.page.bringToFront();
          await tab.page.click("#_actual_bid", { clickCount: 3 });
          await tab.page.keyboard.press("Backspace");
          await tab.page.type("#_actual_bid", tab.amount.toString(), {
            delay: 100,
          });

          const triggerBtn = await tab.page.$(".ywcact-auction-confirm");
          if (triggerBtn) await triggerBtn.click();
          await new Promise((r) => setTimeout(r, 300));

          await this.confirmBid(tab);

          await axios.post("http://127.0.0.1:80/api/bid/create", {
            amount: tab.amount,
            vehicle_id: tab.id,
            phillips_account_email: argv.email,
            bid_stage_id: argv.bid_stage_id,
            status: "Outbidded",
          });
        } else {
          tab.ready = false;
          await axios.post("http://127.0.0.1:80/api/bid/create", {
            amount: tab.amount,
            vehicle_id: tab.id,
            phillips_account_email: argv.email,
            bid_stage_id: argv.bid_stage_id,
            status: "Error",
          });
        }
      }

      const successElement = await tab.page.$("div.woocommerce-message");
      if (successElement) {
        const successMessage = await tab.page.$eval(
          "div.woocommerce-message",
          (el) => el.textContent.trim()
        );
        console.log(`\u2705 Success on ${tab.id}: ${successMessage}`);
        tab.ready = false;
        tab.successful = true;
        await axios.post("http://127.0.0.1:80/api/bid/create", {
          amount: tab.amount,
          vehicle_id: tab.id,
          phillips_account_email: argv.email,
          bid_stage_id: argv.bid_stage_id,
          status: "Highest",
        });
      }
    }
  }

  async close() {
    await this.browser.close();
  }
}

function getDelayUntilTriggerTime(triggerTime) {
  const now = new Date();
  const [hour, minute, second] = triggerTime.split(":" ).map(Number);
  const trigger = new Date(now);
  trigger.setHours(hour, minute, second, 0);
  if (trigger < now) trigger.setDate(trigger.getDate() + 1);
  return trigger - now;
}

function startRetryLoop(sniper, intervalMs = 5000) {
  const interval = setInterval(async () => {
    const activeTabs = sniper.tabs.filter((tab) => tab.ready);
    if (activeTabs.length === 0) {
      console.log("\ud83d\udccb All bids complete. Exiting.");
      clearInterval(interval);
      await sniper.close();
      process.exit(0);
    }
    console.log(`\uD83D\uDD01 Retrying ${activeTabs.length} tab(s)...`);
    await sniper.triggerBids();
  }, intervalMs);
}

(async () => {
  const sniper = new AuctionSniper();
  await sniper.init();
  await sniper.login();

  const initResponse = await axios.post(
    "http://127.0.0.1:80/api/sniping/init",
    {
      auction_session_id: argv.auction_session_id,
      phillips_account_id: argv.phillips_account_id,
    }
  );
  console.log(initResponse.data);

  await sniper.prepareTabs(initResponse.data);

  const delay = getDelayUntilTriggerTime(argv.trigger_time);
  console.log(
    `\u23f3 Waiting until ${argv.trigger_time} (in ${Math.round(
      delay / 1000
    )}s)...`
  );

  setTimeout(async () => {
    console.log(`\ud83d\udea8 Triggering bids at ${new Date().toLocaleTimeString()}`);
    await sniper.triggerBids();
    startRetryLoop(sniper, 3000);
  }, delay);
})();
