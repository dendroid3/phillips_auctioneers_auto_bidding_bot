import puppeteer from "puppeteer";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import axios from "axios";
import https from "https";

// Parse command-line arguments
const argv = yargs(hideBin(process.argv))
  .option("url", {
    alias: "u",
    type: "string",
    description: "Vehicles page URL",
    demandOption: true,
  })
  .option("auction_id", {
    alias: "a",
    type: "number",
    description: "Auction ID for the vehicles' auction session",
    demandOption: true,
  })
  .help()
  .alias("help", "h").argv;

const sendToAPI = async (vehicleData) => {
  try {
    // Create custom https agent to bypass SSL verification for localhost
    const agent = new https.Agent({
      rejectUnauthorized: false,
    });

    const response = await axios.post(
      "http://127.0.0.1:80/api/vehicle/create",
      vehicleData,
      { httpsAgent: agent }
    );
    console.log(
      `API Response for ${vehicleData.id}:`,
      response.status,
      response.data
    );
    return true;
  } catch (error) {
    console.error(`Error sending ${vehicleData.id} to API:`, error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
      console.error("Response status:", error.response.status);
    }
    return false;
  }
};

const scrape = async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    // executablePath: '/usr/bin/google-chrome',
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true, // Use the new headless mode
  });
  const page = await browser.newPage();
  const url = argv.url;

  console.log(`URL is: ${url}`);

  const auction_id = argv.auction_id;
  console.log(
    `scrapping vehicles for vehicles for auction id: ${auction_id} on url: ${url}`
  );
  //   console.log(url);
  await page.goto(url);

  const vehicleIds = await page.evaluate((auction_id) => {
    const results = [];
    const tables = document.querySelectorAll(".wp-block-table table");

    tables.forEach((table) => {
      const rows = table.querySelectorAll("tr:not(:first-child)"); // Skip header row

      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 3) {
          const regNo = cells[1].textContent.trim();
          const makeModel = cells[2].textContent.trim();

          // Format the ID: replace spaces with hyphens and join with regNo
          const formattedRegNo = regNo.replace(/\s+/g, "-");
          const formattedMakeModel = makeModel.replace(/\s+/g, "-");
          const id = `${formattedRegNo}-${formattedMakeModel}`.toUpperCase();

          results.push({
            id,
            auction_id,
          });
        }
      });
    });

    return results;
  }, auction_id);

  // Send data to API after collecting all vehicles
  for (const vehicle of vehicleIds) {
    await sendToAPI(vehicle);
  }

  console.log(vehicleIds);
  await browser.close();
};

scrape();
