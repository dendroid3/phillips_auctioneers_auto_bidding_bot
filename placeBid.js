import puppeteer from "puppeteer";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Parse command-line arguments
const argv = yargs(hideBin(process.argv))
  .option("url", {
    alias: "u",
    type: "string",
    description: "Auction page URL",
    demandOption: true,
  })
  .option("amount", {
    alias: "a",
    type: "number",
    description: "Bid amount to place",
    demandOption: true,
  })
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

const login = async (page, email, password) => {
  console.log("Navigating to login page...");
  await page.goto("https://phillipsauctioneers.co.ke/my-account", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  console.log("Entering credentials...");
  await page.waitForSelector("#username", { visible: true, timeout: 5000 });
  await page.type("#username", email, { delay: 0 });
  await page.waitForSelector("#password", { visible: true, timeout: 5000 });
  await page.type("#password", password, { delay: 0 });

  console.log("Submitting login form...");
  await page.click('[name="login"]');
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 100000 });
};

const placeBid = async (page, url, bidAmount) => {
  console.log(`Navigating to auction page: ${url}`);
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  console.log(`Placing bid of ${bidAmount}...`);
  // Focus and clear the bid input
  await page.focus("#_actual_bid");
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  
  // Type bid amount quickly (delay: 0)
  await page.type("#_actual_bid", bidAmount.toString(), { delay: 0 });

  // Immediately click the confirmation button that's already present
  await page.click(".ywcact-auction-confirm");

  console.log("Waiting for bid confirmation popup...");
  // Only wait for the popup response
  await page.waitForSelector(".pop-up", { visible: true, timeout: 10000 });

  const popupContent = await page.evaluate(() => {
    const popup = document.querySelector(".pop-up");
    return popup ? popup.textContent.trim() : "Popup not found";
  });

  return popupContent;
};

const run = async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  try {
    // Configure browser
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    // Perform login
    await login(page, argv.email, argv.password);

    // Place bid
    const result = await placeBid(page, argv.url, argv.amount);
    console.log("Bid Result:", result);

    // Save evidence
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await page.screenshot({ path: `bid-${timestamp}.png` });

    return { success: true, message: result };
  } catch (error) {
    console.error("Error:", error.message);
    await page.screenshot({ path: "error.png" });
    return { success: false, error: error.message };
  } finally {
    // await browser.close();
    console.log("Finally....");
  }
};

run()
  .then((result) => {
    if (!result.success) process.exit(1);
  })
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
