import puppeteer from "puppeteer";
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
  .option("auction_session_id", {
    alias: "a",
    type: "number",
    demandOption: true,
  })
  .help()
  .alias("help", "h").argv;

const sendResultToAPIURL =
  "http://127.0.0.1:80/api/auction/init_test_results";
const sendResultToAPI = async (payload) => {
  payload.email = argv.email;
  payload.password = argv.password;
  await axios.post(sendResultToAPIURL, payload);
  process.exit(0);
};
(async () => {
  // Initialize the browser
  const browser = await puppeteer.launch({
    // executablePath: '/usr/bin/chromium-browser',
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: 'new,
  });
  try {
    // Open page
    const page = await browser.newPage();

    // Set up request interception to block images
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.resourceType() === "image") {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Open tab
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    // Go to login test
    // Navigate to login page
    await page.goto("https://phillipsauctioneers.co.ke/my-account/", {
      waitUntil: "domcontentloaded",
      timeout: 900000,
    });

    // Enter Credentials
    await page.waitForSelector("#username", { visible: true, timeout: 5000 });
    await page.type("#username", argv.email, { delay: 0 });
    await page.waitForSelector("#password", { visible: true, timeout: 5000 });
    await page.type("#password", argv.password, { delay: 0 });

    // Submit Form
    page.click('[name="login"]'),
      await Promise.race([
        page.waitForSelector(".user-registration-error", {
          timeout: 75000,
        }),
        page.waitForSelector(".user-registration-MyAccount-navigation-link", {
          timeout: 78000,
        }),
      ]);

    // Check for login error, return if there is any error;
    // Return with a status 404 if there is an error
    const errorElement = await page.$("ul.user-registration-error");
    if (errorElement) {
      const payload1 = {
        auction_session_id: argv.auction_session_id,
        success: false,
        message: `Could not log in with the email ${argv.email} and password ${argv.password} (The previous sentence has no ".", if it does then that is part of the password used.)`,
        status: 404,
      };
      sendResultToAPI(payload1);
      return;
    }

    await page.goto("about:blank");
    // Scrape vehicle URLS and send to the backend
    await page.goto("http://phillips.adilirealestate.com/liveAuction.html", {
      waitUntil: "domcontentloaded",
      timeout: 100000,
    });

    const products = await Promise.race([
      page.evaluate(() => {
        const links = Array.from(
          document.querySelectorAll(
            "a.woocommerce-LoopProduct-link.no-lightbox"
          )
        );

        return links
          .filter((_, index) => index % 2 === 0)
          .map((link) => {
            const href = link.href;
            const match = href.match(/product\/([a-z]+-\d+[a-z]?)/i);
            return {
              id: match ? match[1].toUpperCase() : null,
              url: href,
            };
          });
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("evaluate() timed out")), 100000)
      ),
    ]);

    let vehicle_id = "";
    let vehicle_url = "";
    // Send scraped urls to API
    if (products.length > 0) {
      const apiUrl = "http://127.0.0.1:80/api/vehicle/storeUrls";
      const response = await axios.post(apiUrl, products);
      vehicle_id = response.data.last_vehicle_id;
      vehicle_url = response.data.last_vehicle_url;
    }

    // From here on, we have established that the credentials are correct. We can try to place a bid
    // Bid placement block
    // Look for the input and place a bid
    // Navigate to the auction page

    await page.goto("about:blank");
    await page.goto(vehicle_url, {
      waitUntil: "domcontentloaded",
      timeout: 900000,
    });

    await page.focus("#_actual_bid");
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    // Try with a bid of 10000
    let bidAmount = 10000;
    await page.type("#_actual_bid", bidAmount.toString(), { delay: 0 });
    await page.click(".ywcact-auction-confirm");

    const buttons = await page.$$(".ywcact-modal-button-confirm-bid");
    if (buttons.length < 2) throw new Error("Second button missing!");

    await buttons[1].click({ delay: 10 });
    // Check for bid reply, if the bid has been placed
    try {
      await page.waitForFunction(
        () => {
          const errorMsg = document.querySelector("ul.woocommerce-error");
          const successMsg = document.querySelector("div.woocommerce-message");
          return errorMsg || successMsg;
        },
        { timeout: 100000 }
      );

      const errorElement = await page.$("ul.woocommerce-error");
      if (errorElement) {
        // Shows that bid has been placed, even though it was low
        const response = await axios.post(
          "http://127.0.0.1:80/api/bid/create",
          {
            amount: 1000,
            vehicle_id: vehicle_id,
            phillips_account_email: argv.email,
            status: "Outbidded (Test)",
            bid_stage_id: 1,
          }
        );
        const payload2 = {
          auction_session_id: argv.auction_session_id,
          email: argv.email,
          success: true,
          message: `Account ${argv.email} tested successfully. The account will be used in bidding.`,
          status: 200,
        };
        sendResultToAPI(payload2);
        return;
      }

      const successElement = await page.$("div.woocommerce-message");
      if (successElement) {
        // Shows that bid was placed, high enough
        const response = await axios.post("http://127.0.0.1/api/bid/create", {
          amount: 1000,
          vehicle_id: vehicle_id,
          phillips_account_email: argv.email,
          status: "Highest (Test)",
          bid_stage_id: 1,
        });
        const payload3 = {
          auction_session_id: argv.auction_session_id,
          email: argv.email,
          success: true,
          message: `Account ${argv.email} tested successfully. The account will be used in bidding.`,
          status: 200,
        };
        sendResultToAPI(payload3);
        return;
      }
    } catch (error) {
      const payload4 = {
        auction_session_id: argv.auction_session_id,
        email: argv.email,
        success: false,
        message: `Account P4 ${argv.email} failed the test. Try manually to see if it works, if it is authorized to bid, then retry initializing.`,
        status: 403,
      };
      sendResultToAPI(payload4);
      return;
    }
  } catch (error) {
    const payload5 = {
      auction_session_id: argv.auction_session_id,
      error: error,
      success: false,
      message: `Account P5 ${argv.email} failed the test. Try manually to see if it works, if it is authorized to bid, then retry initializing.`,
      status: 403,
    };
    sendResultToAPI(payload5);
    return;
  } finally {
    browser.close();
  }
})();
