import puppeteer from "puppeteer";
import axios from "axios";
import https from "https"; // Import the https module properly

// Helper function to convert "30th May" to "2025-05-30"
const formatAuctionDate = (day, monthName) => {
    const months = {
        january: '01', february: '02', march: '03', april: '04',
        may: '05', june: '06', july: '07', august: '08',
        september: '09', october: '10', november: '11', december: '12'
    };
    
    // Remove ordinal suffix (st, nd, rd, th)
    const dayNumber = day.replace(/(st|nd|rd|th)/i, '');
    const month = months[monthName.toLowerCase()];
    
    return `2025-${month}-${dayNumber.padStart(2, '0')}`;
};

const sendToAPI = async (auctionData) => {
    try {
        // Create custom https agent to bypass SSL verification for localhost
        const agent = new https.Agent({  
            rejectUnauthorized: false
        });

        const response = await axios.post(
            'http://127.0.0.1:80/api/auction/create', // Changed to http to avoid SSL issues
            auctionData,
            { httpsAgent: agent }
        );
        console.log(`API Response for ${auctionData.date}:`, response.status, response.data);
        return true;
    } catch (error) {
        console.error(`Error sending ${auctionData.date} to API:`, error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
            console.error('Response status:', error.response.status);
        }
        return false;
    }
};

const scrape = async () => {
    console.log("Starting scrape...");
    const browser = await puppeteer.launch({
        // executablePath: '/snap/bin/chromium', 
        executablePath: '/usr/bin/google-chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox'], 
        headless: new // Use the new headless mode
    });
    const page = await browser.newPage();
    const url = "https://phillipsauctioneers.co.ke";
    
    try {
        await page.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 100000 // 100 seconds timeout
        });
        
        const auctionData = await page.evaluate(() => {
            const titleLinks = Array.from(document.querySelectorAll('a.wp-block-latest-posts__post-title'));
            const results = [];
            
            titleLinks.forEach(link => {
                const text = link.textContent.trim();
                const href = link.href;
                
                if (text.toLowerCase().includes("online bidding")) {
                    // Improved regex to capture day and month separately
                    const dateMatch = text.match(/(\d{1,2})(?:st|nd|rd|th)\s(\w+)/i);
                    
                    if (dateMatch && dateMatch[1] && dateMatch[2]) {
                        results.push({
                            title: text,
                            rawDate: `${dateMatch[1]} ${dateMatch[2]}`, // "30 May"
                            link: href
                        });
                    }
                }
            });
            
            return results;
        });

        // Process dates after evaluation
        const processedData = auctionData.map(item => {
            const [day, month] = item.rawDate.split(' ');
            return {
                title: item.title,
                date: formatAuctionDate(day, month),
                vehicles_url: item.link
            };
        });

        console.log("Online Bidding Auctions:");
        console.log("-----------------------");
        
        if (processedData.length === 0) {
            console.log("No online bidding auctions found");
        } else {
            // Send each auction to the API sequentially
            for (const auction of processedData) {
                console.log("Sending to API:", auction);
                await sendToAPI(auction);
                await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between requests
            }
        }
    } catch (error) {
        console.error("Scraping failed:", error);
    } finally {
        await browser.close();
    }
}

scrape();
