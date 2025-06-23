import puppeteer from "puppeteer";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import axios from "axios";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

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

const createLogger = () => {
  const logDir = "logs";
  const textLogPath = path.join(
    logDir,
    `${argv.vehicle_id}-${argv.vehicle_name}-${argv.email}.txt`
  );
  const pdfLogPath = path.join(
    logDir,
    `${argv.vehicle_id}-${argv.vehicle_name}-${argv.email}.pdf`
  );
  const formatTime = () => {
    const now = new Date();
    const pad = (num) => num.toString().padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
      now.getSeconds()
    )}`;
  };

  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

  // ANSI color codes for console
  const colors = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    blue: "\x1b[34m",
    reset: "\x1b[0m",
  };

  // PDF color equivalents (RGB)
  const pdfColors = {
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    black: [0, 0, 0],
  };

  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

  if (fs.existsSync(textLogPath)) {
    const separator =
      "\n\n------------------------------------------------------\n" +
      formatTime() +
      ": We've been outbid, another sprint:\n" +
      "Stage: " +
      argv.bid_stage +
      "\n" +
      "Increment: " +
      argv.increment +
      "\n" +
      "------------------------------------------------------\n";
    fs.appendFileSync(textLogPath, separator);
  } else {
    const separator =
      "------------------------------------------------------\n" +
      "LOGS FOR VEHICLE " +
      argv.vehicle_id +
      " " +
      argv.vehicle_name +
      "\n------------------------------------------------------\n\n" +
      "------------------------------------------------------\n" +
      formatTime() +
      ": We've began bidding, first sprint:\n" +
      "Stage: " +
      argv.bid_stage +
      "\n" +
      "Increment: " +
      argv.increment +
      "\n" +
      "------------------------------------------------------\n";
    fs.appendFileSync(textLogPath, separator);
  }

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
      const divider = "\n\n-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+\n";
      console.log(divider);
      fs.appendFileSync(textLogPath, divider);
    },
    generatePdf: () => {
      const doc = new PDFDocument();
      doc.pipe(fs.createWriteStream(pdfLogPath));

      // Read text log and apply colors
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
    waitUntil: "domcontentloaded", // Changed from networkidle2
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
  if (!chasing) {
    logger.info(`Navigating to auction page`);
  } else {
    logger.info(`We are chasing the highest`);
  }

  await page.goto(url, {
    waitUntil: "domcontentloaded", // Changed from networkidle2
    timeout: 30000,
  });

  logger.info(`Placing bid of ${bidAmount}`);
  await prepBid(page, bidAmount);

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

        await new Promise((resolve) => {
          const waitTime = Math.floor(Math.random() * 1001) + 1000;
          logger.info(
            `New bid will be placed in ~${Math.round(waitTime / 100)} seconds`
          );
          setTimeout(resolve, waitTime);
        });
        return placeBid(page, url, newBidAmount, true);
      } else {
        throw new Error(`Reached maximum bid amount of ${argv.maximum_amount}`);
      }
    }

    const successElement = await page.$("div.woocommerce-message");
    if (successElement) {
      logger.success(`We are the highest bidder.`);
      const response = await axios.post(
        "http://127.0.0.1:80/api/bid/create",
        {
          amount: bidAmount,
          vehicle_id: argv.vehicle_id,
          phillips_account_email: argv.email,
          status: "Highest",
        }
      );
      logger.success(`${response.data.status}`);
      return true;
    }
  } catch (err) {
    if (err.name === "TimeoutError") {
      logger.error("ℹ️ No confirmation message detected within timeout period");
    } else if (!err.message.includes("waiting for selector")) {
      logger.error(`Error checking bid status: ${err.message}`);
    }
    throw err;
  }
};

const run = async () => {
  const browser = await puppeteer.launch({
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

    await login(page, argv.email, argv.password);
    const result = await placeBid(page, argv.url, argv.amount);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await page.screenshot({ path: `bid-${timestamp}.png` });

    return { success: true, message: result };
  } catch (error) {
    logger.error(`${error.message}`);
    await page.screenshot({ path: "error.png" });
    return { success: false, error: error.message };
  } finally {
    browser.close();
    logger.success("Sprint Complete");
    const pdfPath = logger.generatePdf();
    console.log(`PDF generated at: ${pdfPath}`);
  }
};

run()
  .then((result) => {
    if (!result.success) process.exit(1);
  })
  .catch((err) => {
    logger.error(`Fatal error: ${err}`);
    process.exit(1);
  });
