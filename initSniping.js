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
    console.log("🔐 Logging in...");
    await this.mainPage.goto("https://phillipsauctioneers.co.ke/my-account", {
      waitUntil: "networkidle2",
      timeout: 600000,
    });

    await this.mainPage.type("#username", argv.email);
    await this.mainPage.type("#password", argv.password);
    await this.mainPage.click('[name="login"]');
    await this.mainPage.waitForNavigation({ waitUntil: "networkidle2" });
    console.log("✅ Login successful.");
  }

  async prepareTabs(vehicleData) {
    console.log(`🧹 Preparing ${vehicleData.length} tabs...`);
    for (const vehicle of vehicleData) {
      const tab = await this.browser.newPage();
      const cookies = await this.mainPage.cookies();
      await tab.setCookie(...cookies);
      await tab.goto(vehicle.url, { waitUntil: "networkidle2" });

      const initialAmount = vehicle.current_bid ? Math.min(
        vehicle.current_bid + vehicle.sniping_stage_increment,
        vehicle.maximum_amount
      ) : Math.min(vehicle.start_amount);

      await tab.waitForSelector("#_actual_bid", { timeout: 10000 });
      await tab.click("#_actual_bid", { clickCount: 3 });
      await tab.keyboard.press("Backspace");
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
      });

      console.log(`✅ Tab ready for vehicle ${vehicle.id}`);
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

    console.log(response.data);

    const vehiclesToTrigger = response.data;
    console.log(
      `🚀 Triggering bids for ${vehiclesToTrigger.length} vehicles...`
    );

    for (const vehicle of vehiclesToTrigger) {
      const tab = this.tabs.find((t) => t.id === vehicle.id && t.ready);
      if (!tab) continue;

      try {
        await tab.page.bringToFront();
        await new Promise((r) => setTimeout(r, 300));

        const buttons = await tab.page.$$(".ywcact-modal-button-confirm-bid");
        if (buttons.length >= 2) {
          await Promise.all([
            tab.page.waitForNavigation({ waitUntil: "networkidle2" }),
            buttons[1].click({ delay: 100 }),
          ]);
          tab.triggered = true;
          console.log(`🔫 Confirmed bid on ${tab.id} of ${tab.amount}`);
        }
      } catch (err) {
        console.error(`❌ Failed to confirm bid on ${tab.id}: ${err.message}`);
      }
    }

    for (const tab of this.tabs.filter((t) => t.triggered && t.ready)) {
      try {
        const errorElement = await tab.page.$("ul.woocommerce-error");
        if (errorElement) {
          const errorMessage = await tab.page.$eval(
            "ul.woocommerce-error li",
            (el) => el.textContent.trim()
          );
          console.log(`❌ Error on ${tab.id}: ${errorMessage}`);

          if (errorMessage.toLowerCase().includes("higher")) {
            if (tab.placedMax) {
              console.log(`🚫 Max bid already placed on ${tab.id}, no retry.`);
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

            const nextBid = tab.amount + tab.increment;
            const newAmount = nextBid > tab.maxAmount ? tab.maxAmount : nextBid;
            tab.placedMax = newAmount >= tab.maxAmount;

            if (newAmount === tab.amount) {
              console.log(`🚫 Already placed max bid on ${tab.id}, skipping.`);
              tab.ready = false;
              continue;
            }

            tab.retries++;
            tab.amount = newAmount;
            console.log(`🔁 Retrying ${tab.id} with amount ${tab.amount}`);

            await tab.page.bringToFront();
            await new Promise((r) => setTimeout(r, 300));

            await tab.page.click("#_actual_bid", { clickCount: 3 });
            await tab.page.keyboard.press("Backspace");
            await tab.page.type(tab.amount.toString(), { delay: 100 });

            const triggerBtn = await tab.page.$(".ywcact-auction-confirm");
            if (triggerBtn) await triggerBtn.click();
            await new Promise((r) => setTimeout(r, 300));

            const buttons = await tab.page.$$(
              ".ywcact-modal-button-confirm-bid"
            );
            if (buttons.length >= 2) {
              await Promise.all([
                tab.page.waitForNavigation({ waitUntil: "networkidle2" }),
                buttons[1].click({ delay: 100 }),
              ]);
              console.log(`🔁 Re-confirmed bid on ${tab.id}`);
              await axios.post("http://127.0.0.1:80/api/bid/create", {
                amount: tab.amount,
                vehicle_id: tab.id,
                phillips_account_email: argv.email,
                bid_stage_id: argv.bid_stage_id,
                status: "Outbidded",
              });
            }
          } else {
            console.log(`⚠️ Error on ${tab.id} not retryable.`);
            tab.ready = false;
          }
        }

        const successElement = await tab.page.$("div.woocommerce-message");
        if (successElement) {
          const successMessage = await tab.page.$eval(
            "div.woocommerce-message",
            (el) => el.textContent.trim()
          );
          console.log(`✅ Success on ${tab.id}: ${successMessage}`);
          tab.ready = false;
          await axios.post("http://127.0.0.1:80/api/bid/create", {
            amount: tab.amount,
            vehicle_id: tab.id,
            phillips_account_email: argv.email,
            bid_stage_id: argv.bid_stage_id,
            status: "Highest",
          });
        }
      } catch {
        console.log(
          `⏳ No confirmation message on ${tab.id}, retrying with same amount...`
        );

        try {
          await tab.page.bringToFront();
          await new Promise((r) => setTimeout(r, 300));
          await tab.page.reload({
            waitUntil: "domcontentloaded"
          });

          await tab.page.click("#_actual_bid", { clickCount: 3 });
          await tab.page.keyboard.press("Backspace");
          await tab.page.type(tab.amount.toString(), { delay: 100 });

          const triggerBtn = await tab.page.$(".ywcact-auction-confirm");
          if (triggerBtn) await triggerBtn.click();

          await new Promise((r) => setTimeout(r, 300));
          const buttons = await tab.page.$$(".ywcact-modal-button-confirm-bid");
          if (buttons.length >= 2) {
            await Promise.all([
              tab.page.waitForNavigation({ waitUntil: "networkidle2" }),
              buttons[1].click({ delay: 100 }),
            ]);
            console.log(
              `♻️ Retried bid confirm on ${tab.id} with same amount (${tab.amount})`
            );
          } else {
            console.log(`❓ Still no confirmation modal for ${tab.id}`);
          }
        } catch (retryErr) {
          console.error(`❌ Retry failed for ${tab.id}: ${retryErr.message}`);
        }
      }
    }
  }

  async close() {
    await this.browser.close();
  }
}

function getDelayUntilTriggerTime(triggerTime) {
  const now = new Date();
  const [hour, minute, second] = triggerTime.split(":").map(Number);
  const trigger = new Date(now);
  trigger.setHours(hour, minute, second, 0);
  if (trigger < now) trigger.setDate(trigger.getDate() + 1);
  return trigger - now;
}

function startRetryLoop(sniper, intervalMs = 5000) {
  const interval = setInterval(async () => {
    const activeTabs = sniper.tabs.filter((tab) => tab.ready);
    if (activeTabs.length === 0) {
      console.log("📋 All bids complete. Exiting.");
      clearInterval(interval);
      await sniper.close();
      process.exit(0);
    }
    console.log(`🔁 Retrying ${activeTabs.length} tab(s)...`);
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
  console.log("rere");
  console.log(initResponse.data);

  await sniper.prepareTabs(initResponse.data);

  const delay = getDelayUntilTriggerTime(argv.trigger_time);
  console.log(
    `⏳ Waiting until ${argv.trigger_time} (in ${Math.round(delay / 1000)}s)...`
  );

  setTimeout(async () => {
    console.log(`🚨 Triggering bids at ${new Date().toLocaleTimeString()}`);
    await sniper.triggerBids();
    startRetryLoop(sniper, 3000);
  }, delay);
})();
