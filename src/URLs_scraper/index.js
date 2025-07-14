// scrape_target.js
import { chromium } from "playwright"
import {
  formatOutput,
  saveResults,
  getAppliedTags,
  goToNextPage,
  scrollAndCollect,
  switchToNextTypeFilter,
} from "../helpers.js"
import "dotenv/config"

const START_URL =
  "https://www.target.com/c/kids/-/N-xcoz4Z5zlb2Zdze4?moveTo=product-list-grid"
const URLS_PER_ARRAY = 50
const MAX_TYPES = 100 // Adjust as you wish
const headless = process.env.HEADLESS === "true"
let firstType = null
let lastType = null

async function main() {
  const browser = await chromium.launch({ headless: headless })
  const page = await browser.newPage()
  console.log("Open New Page")
  await page.goto(START_URL, { waitUntil: "domcontentloaded" })

  let allProducts = []
  let currentTypeIndex = 0
  let typeSwitchResult = await switchToNextTypeFilter(page) // Pass true for first type

  firstType = typeSwitchResult?.current || "unknown"

  while (true) {
    currentTypeIndex++
    lastType = typeSwitchResult?.current || lastType

    let pageCount = 1

    while (true) {
      console.log(
        `Scraping Type "${typeSwitchResult.current}" - page ${pageCount}...`
      )
      const pageUrls = await scrollAndCollect(page)
      const extraTags = await getAppliedTags(page)

      // Add each product url as a new entry with its tags and type
      const sortedTags = [...extraTags].sort().join(", ")
      pageUrls.forEach((url) =>
        allProducts.push({
          url,
          tags: sortedTags,
        })
      )

      const hasNext = await goToNextPage(page)
      if (!hasNext) break
      pageCount++
    }

    if (
      !typeSwitchResult ||
      !typeSwitchResult.next ||
      currentTypeIndex >= MAX_TYPES
    )
      break

    typeSwitchResult = await switchToNextTypeFilter(page)
  }

  // Deduplicate products by url, keeping the first occurrence
  const seen = new Set()
  const dedupedProducts = allProducts.filter((p) => {
    if (seen.has(p.url)) return false
    seen.add(p.url)
    return true
  })

  const output = formatOutput({
    urlArray: dedupedProducts,
    arraySize: URLS_PER_ARRAY,
    extraSummary: {
      typesScraped: currentTypeIndex,
    },
  })

  const fileName = `${firstType}---${currentTypeIndex}---${lastType}`.replace(
    /[\\/:*?"<>|]+/g,
    "_"
  )
  const filePath = saveResults(output, fileName)
  console.log(
    `Saved ${output.summary.totalProducts} unique products to: ${filePath}`
  )

  await browser.close()
}
main()
