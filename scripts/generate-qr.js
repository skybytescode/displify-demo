/**
 * generate-qr.js
 * Pre-generates QR codes for every insight in ai-insights.json
 * and stores them as base64 data URIs in the JSON.
 *
 * Run once (or whenever URLs change):
 *   node scripts/generate-qr.js
 *
 * Requires Node 18+ (built-in fetch) or Node 16 with node-fetch.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const INSIGHTS_PATH = path.join(__dirname, '../src/assets/ai-insights.json');
const QR_SIZE       = '300x300';
const QR_COLOR      = '94a3b8';   // light slate — matches app text colour
const QR_BG         = '06060f';   // near-black — matches app background

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const raw  = fs.readFileSync(INSIGHTS_PATH, 'utf8');
  const json = JSON.parse(raw);

  console.log(`Processing ${json.insights.length} insights…\n`);

  for (const insight of json.insights) {
    const encoded = encodeURIComponent(insight.url);
    const apiUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=${QR_SIZE}&data=${encoded}&color=${QR_COLOR}&bgcolor=${QR_BG}&qzone=1`;

    try {
      console.log(`  Fetching QR for "${insight.title}"…`);
      const buf    = await fetchBuffer(apiUrl);
      insight.qr   = `data:image/png;base64,${buf.toString('base64')}`;
      console.log(`  ✓  ${insight.id} (${buf.length} bytes)`);
    } catch (err) {
      console.error(`  ✗  ${insight.id}: ${err.message}`);
    }
  }

  fs.writeFileSync(INSIGHTS_PATH, JSON.stringify(json, null, 2));
  console.log(`\nDone — ${INSIGHTS_PATH} updated.`);
}

main();
