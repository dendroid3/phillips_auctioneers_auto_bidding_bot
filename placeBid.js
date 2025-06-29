#!/usr/bin/env node
import puppeteer from "puppeteer";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import axios from "axios";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

// Configure absolute paths
const LOG_DIR = "/var/www/phillips/bot/logs";
const CHROME_PATH = "/usr/bin/google-chrome";

const argv = yargs(hideBin(process.argv))
  .option("url", { alias: "u", type: "string", demandOption: true })
  .option("amount", { alias: "a", type: "number", demandOption: true })
  .option("increment", { alias: "i", type: "number", demandOption: true })
  .option("maximum_amount", { alias: "m", type: "number", demandOption: true })
  .option("email", { alias: "e", type: "string", demandOption: true })
  .option("password", { alias: "p", type: "string", demandOption: true })
  .option("vehicle_id", { alias: "v", type: "number", demandOption: true })
  .option("vehicle_name", { alias: "n", type: "string", demandOption: true })
  .option("bid_stage", { alias: "s", type: "string", demandOption: true })
  .help()
  .alias("help", "h").argv;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o775 });
}

const createLogger = () => {
  const textLogPath = path.join(
    LOG_DIR,
    `${argv.vehicle_id}-${argv.vehicle_name}.txt`
  );
  const pdfLogPath = path.join(
    LOG_DIR,
    `${argv.vehicle_id}-${argv.vehicle_name}.pdf`
  );

  const formatTime = () => {
    const now = new Date();
    const pad = (num) => num.toString().padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
      now.getSeconds()
    )}`;
  };

  // ANSI colors for console
  const colors = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    blue: "\x1b[34m",
    reset: "\x1b[0m",
  };

  // PDF colors
  const pdfColors = {
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    black: [0, 0, 0],
  };

  const initLogFile = () => {
    if (!fs.existsSync(textLogPath)) {
      const header = [
        "------------------------------------------------------",
        `LOGS FOR VEHICLE ${argv.vehicle_id} ${argv.vehicle_name}`,
        "------------------------------------------------------",
        "",
        "------------------------------------------------------",
        `${formatTime()}: Bidding started`,
        `Stage: ${argv.bid_stage}`,
        `Account: ${argv.email}`,
        `Increment: ${argv.increment}`,
        "------------------------------------------------------",
        "",
      ].join("\n");
      fs.writeFileSync(textLogPath, header);
    }
  };

  initLogFile();

  return {
    log: (message) => {
      const logMessage = `${formatTime()}: ${message}`;
      console.log(logMessage);
      fs.appendFileSync(textLogPath, logMessage + "\n");
    },
    success: (message) => {
      const logMessage = `${formatTime()}, SUCCESS: ${message}`;
      console.log(`${colors.green}${logMessage}${colors.reset}`);
      fs.appendFileSync(textLogPath, `${logMessage}\n`);
    },
    error: (message) => {
      const logMessage = `${formatTime()}, ERROR: ${message}`;
      console.error(`${colors.red}${logMessage}${colors.reset}`);
      fs.appendFileSync(textLogPath, `${logMessage}\n`);
    },
    info: (message) => {
      const logMessage = `${formatTime()}, INFO: ${message}`;
      console.log(`${colors.blue}${logMessage}${colors.reset}`);
      fs.appendFileSync(textLogPath, `${logMessage}\n`);
    },
    divider: () => {
      const divider = "\n-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+\n";
      console.log(divider);
      fs.appendFileSync(textLogPath, divider);
    },
    generatePdf: () => {
      const doc = new PDFDocument();
      doc.pipe(fs.createWriteStream(pdfLogPath));

      const logContent = fs.readFileSync(textLogPath, "utf8");
      const lines = logContent.split("\n");

      lines.forEach((line) => {
        if (line.includes("SUCCESS:")) {
          doc.fillColor(pdfColors.green).text(line + "\n");
        } else if (line.includes("ERROR:")) {
          doc.fillColor(pdfColors.red).text(line + "\n");
        } else if (line.includes("INFO:")) {
          doc.fillColor(pdfColors.blue).text(line + "\n");
        } else {
          doc.fillColor(pdfColors.black).text(line + "\n");
        }
      });

      doc.end();
      return pdfLogPath;
    },
  };
};

const logger = createLogger();

const login = async (page, email, password) => {
  logger.info("Navigating to login page");
  await page.goto("https://phillipsauctioneers.co.ke/my-account", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  logger.info("Entering credentials");
  await page.waitForSelector("#username", { visible: true, timeout: 5000 });
  await page.type("#username", email, { delay: 0 });
  await page.waitForSelector("#password", { visible: true, timeout: 5000 });
  await page.type("#password", password, { delay: 0 });

  logger.info("Submitting login form");
  await page.click('[name="login"]');
  await page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 10000,
  });
  logger.success("Logged in successfully");
};

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
  logger.info("Waiting for bid confirmation popup");
};

const placeBid = async (page, url, bidAmount, chasing = false) => {
  logger.divider();
  logger.info(
    chasing ? `We are chasing the highest` : `Navigating to auction page`
  );

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  logger.info(`Placing bid of ${bidAmount}`);
  await prepBid(page, bidAmount);

  try {
    await page.waitForFunction(
      () =>
        document.querySelector("ul.woocommerce-error") ||
        document.querySelector("div.woocommerce-message"),
      { timeout: 10000 }
    );

    const errorElement = await page.$("ul.woocommerce-error");
    if (errorElement) {
      logger.error(`There is a higher current bid`);

      if (bidAmount + argv.increment <= argv.maximum_amount) {
        const newBidAmount = bidAmount + argv.increment;
        const response = await axios.post(
          "http://127.0.0.1:80/api/bid/create",
          {
            amount: bidAmount,
            vehicle_id: argv.vehicle_id,
            phillips_account_email: argv.email,
            status: "Outbidded",
          }
        );

        logger.error(`${response.data.status}`);

        const waitTime = Math.floor(Math.random() * 10001) + 10000;
        logger.info(
          `New bid will be placed in ~${Math.round(waitTime / 1000)} seconds`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        return placeBid(page, url, newBidAmount, true);
      } else {
        logger.error(
          `Attempting final bid with maximum amount of ${argv.maximum_amount}`
        );
        return placeBid(page, url, argv.maximum_amount, true);
      }
    }

    const successElement = await page.$("div.woocommerce-message");
    if (successElement) {
      logger.success(`We are the highest bidder.`);
      const response = await axios.post("http://127.0.0.1:80/api/bid/create", {
        amount: bidAmount,
        vehicle_id: argv.vehicle_id,
        phillips_account_email: argv.email,
        status: "Highest",
      });
      logger.success(`${response.data.status}`);
      return true;
    }
  } catch (err) {
    if (err.name === "TimeoutError") {
      logger.error("No confirmation message detected, retrying...");
      const waitTime = Math.floor(Math.random() * 1001) + 1000;
      logger.info(`Retrying in ~${Math.round(waitTime / 100)} seconds`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return placeBid(page, url, bidAmount, true);
    }
    throw err;
  }
};

const run = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--disable-gpu",
      `--user-data-dir=/var/www/.config/google-chrome`,
      `--disk-cache-dir=/var/www/.cache/google-chrome`,
    ],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    req.resourceType() === "image" ? req.abort() : req.continue();
  });

  try {
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    await login(page, argv.email, argv.password);
    const result = await placeBid(page, argv.url, argv.amount);

    return { success: true, message: result };
  } catch (error) {
    logger.error(`${error.message}`);
    await page.screenshot({ path: path.join(LOG_DIR, "error.png") });
    return { success: false, error: error.message };
  } finally {
    await browser.close();
    logger.success("Sprint Complete");
    const pdfPath = logger.generatePdf();
    logger.info(`PDF generated at: ${pdfPath}`);
  }
};

run()
  .then((result) => !result.success && process.exit(1))
  .catch((err) => {
    logger.error(`Fatal error: ${err}`);
    process.exit(1);
  });
