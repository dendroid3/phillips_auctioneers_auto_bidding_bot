import puppeteer from "puppeteer";
import axios from "axios";
import https from "https";

// (async () => {
//   const browser = await puppeteer.launch({
//     // executablePath: '/usr/bin/chromium-browser'
//     args: ["--no-sandbox", "--disable-setuid-sandbox"],
//     headless: true,
//   });
//   const page = await browser.newPage();

//   try {
//     // Step 1: Navigate to the page and scrape data
//     await page.goto('https://phillipsauctioneers.co.ke/live-auction/', { waitUntil: 'domcontentloaded' });

//     const products = await page.evaluate(() => {
//       const links = Array.from(document.querySelectorAll('a.woocommerce-LoopProduct-link.no-lightbox'));
      
//       return links
//         .filter((_, index) => index % 2 === 0) // Get odd elements
//         .map(link => {
//           const href = link.href;
//         //   const match = href.match(/product\/([^-]+)/);
//           const match = href.match(/product\/([a-z]+-\d+[a-z]?)/i);
//           return {
//             id: match ? match[1].toUpperCase() : null,
//             url: href
//           };
//         });
//     });

//     console.log('Scraped data:', products);

//     // Step 2: Send data to API
//     if (products.length > 0) {
//       try {
//         const apiUrl = 'http://127.0.0.1:80/api/vehicle/storeUrls';
//         const response = await axios.post(apiUrl, products);
        
//         console.log('API Response:', response.data);
//         console.log('Data successfully sent to API');
//       } catch (apiError) {
//         console.error('API Error:', apiError.response ? apiError.response.data : apiError.message);
//       }
//     } else {
//       console.log('No products found to send to API');
//     }

//   } catch (error) {
//     console.error('Scraping Error:', error);
//   } finally {
//     await browser.close();
//   }
// })();

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  try {
    await page.goto("https://phillipsauctioneers.co.ke/live-auction/", {
      waitUntil: "domcontentloaded",
    });

    // Get array of objects with id and url
    const products = await page.evaluate(() => {
      const links = Array.from(
        document.querySelectorAll("a.woocommerce-LoopProduct-link.no-lightbox")
      );

      return links
        .filter((_, index) => index % 2 === 0) // Get odd elements
        .map((link) => {
          const href = link.href;
          //   const match = href.match(/product\/([^-]+)/);
          const match = href.match(/product\/([a-z]+-\d+[a-z]?)/i);
          return {
            id: match ? match[1].toUpperCase() : null,
            url: href,
          };
        });
    });

    // Log the results as array of objects
    console.log("Products:");
    console.log(products);

    // Alternative formatted output
    console.log("\nFormatted output:");
    products.forEach((product, i) => {
      console.log(`${i + 1}: ID: ${product.id} | URL: ${product.url}`);
    });
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await browser.close();
  }
})();
