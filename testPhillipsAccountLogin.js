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
  .help()
  .alias("help", "h").argv;

const prepBid = async (page, bidAmount) => {
  await page.focus("#_actual_bid");
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");

  await page.type("#_actual_bid", bidAmount.toString(), { delay: 0 });
  await page.click(".ywcact-auction-confirm");

  const buttons = await page.$$(".ywcact-modal-button-confirm-bid");
  if (buttons.length < 2) throw new Error("Second button missing!");

  await buttons[1].click({ delay: 10 });
  console.log("Waiting for bid confirmation popup");
};

const placeBid = async (page, url, vehicle_id) => {
  await page.goto(url, {
    waitUntil: "domcontentloaded", // Changed from networkidle2
    timeout: 30000,
  });

  console.log(`Placing bid of 1000`);
  await prepBid(page, 1000);

  try {
    await page.waitForFunction(
      () => {
        const errorMsg = document.querySelector("ul.woocommerce-error");
        const successMsg = document.querySelector("div.woocommerce-message");
        return errorMsg || successMsg;
      },
      { timeout: 10000 }
    );

    const errorElement = await page.$("ul.woocommerce-error");
    if (errorElement) {
      const response = await axios.post(
        "http://127.0.0.1:80/api/bid/create",
        {
          amount: 1000,
          vehicle_id: vehicle_id,
          phillips_account_email: argv.email,
          status: "Outbidded",
        }
      );
      console.log("Bid failed but successfully placed");
      return true;
    }

    const successElement = await page.$("div.woocommerce-message");
    if (successElement) {
      console.log(`We are the highest bidder.`);
      const response = await axios.post(
        "http://127.0.0.1:80/api/bid/create",
        {
          amount: 1000,
          vehicle_id: vehicle_id,
          phillips_account_email: argv.email,
          status: "Highest",
        }
      );
      console.log("bid successfully placed");
      return true;
    }
  } catch (err) {
    if (err.name === "TimeoutError") {
      console.log("ℹ️ No confirmation message detected within timeout period");
      return {
        message: "Not authorized",
        success: false,
      };
    } else if (!err.message.includes("waiting for selector")) {
      console.log(`Error checking bid status: ${err.message}`);
    }
    throw err;
  }
};

const login = async (page, email, password) => {
  try {
    console.log("Navigating to login page");
    await page.goto("https://phillipsauctioneers.co.ke/my-account", {
      waitUntil: "domcontentloaded",
      timeout: 900000,
    });

    console.log("Entering Credentials...");
    await page.waitForSelector("#username", { visible: true, timeout: 5000 });
    await page.type("#username", email, { delay: 0 });
    await page.waitForSelector("#password", { visible: true, timeout: 5000 });
    await page.type("#password", password, { delay: 0 });

    console.log("Submitting Login Form");
    page.click('[name="login"]'),
      await Promise.race([
        page.waitForSelector(".user-registration-error", {
          timeout: 60000,
        }), // Error
        page.waitForSelector(".user-registration-MyAccount-navigation-link", {
          timeout: 60000,
        }),
      ]);

    // Check for login errors
    const errorElement = await page.$("ul.user-registration-error");
    if (errorElement) {
      const errorText = await page.evaluate(
        (el) => el.textContent,
        errorElement
      );
      return { success: false, error: errorText.trim() };
    }

    console.log("Logged in successfully");

    // No Errors, navigate to live auction and try bidding
    const result = await bidTrial(page);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const bidTrial = async (page) => {
  try {
    console.log("BidTrial Called");
    await page.goto("http://phillips.adilirealestate.com/liveAuction.html", {
      waitUntil: "domcontentloaded",
      timeout: 900000,
    });

    // Scrape Vehicle URLS
    const products = await page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll("a.woocommerce-LoopProduct-link.no-lightbox")
      );

      return links
        .filter((_, index) => index % 2 === 0) // Get odd elements
        .map((link) => {
          const href = link.href;
          const match = href.match(/product\/([a-z]+-\d+[a-z]?)/i);
          return {
            id: match ? match[1].toUpperCase() : null,
            url: href,
          };
        });
    });

    // Send scraped urls to API
    if (products.length > 0) {
      try {
        const apiUrl = "http://127.0.0.1:80/api/vehicle/storeUrls";
        const response = await axios.post(apiUrl, products);

        console.log("API Response:", response.data);
        console.log("Data successfully sent to API");

        // This is where we should try to bid
        await placeBid(
          page,
          response.data.last_vehicle_url,
          response.data.last_vehicle_id
        );
      } catch (apiError) {
        console.error(
          "API Error:",
          apiError.response ? apiError.response.data : apiError.message
        );
      }
    } else {
      console.log("No products found to send to API");
    }

    console.log("Scraped data:", products[0].url);

    return { success: true };
  } catch (error) {
    console.error("BidTrial Error:", error);
    return { success: false, error: error.message };
  }
};

const run = async () => {
  const browser = await puppeteer.launch({
    executablePath: "/snap/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true,
  });
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

  try {
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    const login_result = await login(page, argv.email, argv.password);

    if (login_result.success) {
      console.log("login success");
      // return "Success";
    } else {
      return {
        success: false,
        message: `Could not login with ${argv.email}`,
      };
      console.log("Login Failed");
      // return "Fail";
    }
  } catch (error) {
    console.log(error);
  } finally {
    browser.close();
  }
};

run();
