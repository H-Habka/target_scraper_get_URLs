// helpers.js
import fs from "fs"
import path from "path"
const BASE_URL = "https://www.target.com"

export function getFormattedDateISO() {
  const now = new Date()
  const pad = (n) => n.toString().padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

export function formatOutput({ urlArray, extraSummary, arraySize = 10 }) {
  const chunked = {}
  for (let i = 0; i < urlArray.length; i += arraySize) {
    chunked[`array${Math.floor(i / arraySize) + 1}`] = urlArray.slice(
      i,
      i + arraySize
    )
  }
  return {
    urls: chunked,
    summary: {
      totalProducts: urlArray.length,
      collectedAt: getFormattedDateISO(),
      ...extraSummary,
    },
  }
}

export function saveResults(output) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dir = "URL_scraper_output"
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const filename = path.join(dir, `target_urls_${timestamp}.json`)
  fs.writeFileSync(filename, JSON.stringify(output, null, 2))
  return filename
}

export async function getAppliedTags(page) {
  return await page.evaluate(() => {
    // Find the filter bar by its data-test attribute
    const appliedFiltersBar = document.querySelector(
      'div[data-module-type="ListingPageFilterBar"] > div > div > div > div > div[data-test="lp-filterBar"]'
    )
    if (!appliedFiltersBar) return []

    // Find the <ul> containing the tags
    const ul = appliedFiltersBar.querySelector("ul")
    if (!ul) return []

    console.log("TEST")
    // Loop over all <li> except the one with data-test="clear-all-link"
    return Array.from(ul.querySelectorAll("li"))
      .filter((li) => li.getAttribute("data-test") !== "clear-all-link")
      .map((li) => {
        const btn = li.querySelector("button > div.h-text-md")
        return btn?.innerText?.trim() || ""
      })
  })
}

export async function goToNextPage(page) {
  // Try to find pagination instantly, don't wait if not there
  const pagination = await page.$('div[data-test="pagination"]')
  if (!pagination) return false // No pagination, only one page

  // Find the next button and check if it's disabled
  const nextBtn = await pagination.$('button[data-test="next"]')
  if (!nextBtn) return false
  const disabled = await nextBtn.getAttribute("disabled")
  if (disabled !== null) return false // It's disabled, last page

  // Click next and wait for navigation
  await Promise.all([
    nextBtn.click(),
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
  ])
  return true
}

export async function scrollAndCollect(page) {
  // Scroll for lazy loading
  for (let i = 1; i <= 20; i++) {
    await page.evaluate((progress) => {
      window.scrollTo({
        top: document.body.scrollHeight * (progress / 20),
        behavior: "smooth",
      })
    }, i)
    await page.waitForTimeout(700)
  }

  // Wait for product cards wrapper
  await page.waitForSelector(
    'div[data-module-type="ListingPageProductListCards"]',
    { timeout: 10000 }
  )

  // Collect unique product URLs on this page
  const urls = await page.evaluate((BASE_URL) => {
    const wrapper = document.querySelector(
      'div[data-module-type="ListingPageProductListCards"]'
    )
    if (!wrapper) return []
    const anchors = wrapper.querySelectorAll('a[href^="/p/"]')
    const urlSet = new Set()
    anchors.forEach((a) => {
      if (a && a.getAttribute("href")) {
        let rel = a.getAttribute("href").split("?")[0].split("#")[0]
        urlSet.add(BASE_URL + rel)
      }
    })
    return Array.from(urlSet)
  }, BASE_URL)

  return urls
}

/**
 * Opens the Type filter in Target's filter bar,
 * unchecks the currently checked type, checks the next one, applies the filter, and waits for the modal to close.
 * Returns { previous: <string|null>, next: <string|null>, typeOptions: [string] }
 * If no next type, does not change the filter and returns null.
 */
export async function switchToNextTypeFilter(page) {
  // STEP 1: Open filter bar and click "Filter" button
  const filterBarSelector =
    'div[data-module-type="ListingPageFilterBar"] > div > div > div > div[data-test="lp-filterBar"]'
  const filterBar = await page.waitForSelector(filterBarSelector)
  const filterButton = await filterBar.$(
    'ul > li:nth-child(1) button[data-test="filters-menu"]'
  )
  if (!filterButton) throw new Error("Filter menu button not found")
  await filterButton.click()

  // STEP 2: Click "Type" filter button in the drawer
  const typeBtn = await page.waitForSelector(
    'div[data-floating-ui-portal] button[data-test="facet-group-d_item_type_all"]'
  )
  await typeBtn.click()

  // STEP 3: Wait for the Type filter modal/drawer
  const modal = await page.waitForSelector(
    'div[data-floating-ui-portal] div[data-floating-ui-portal] div[data-floating-ui-focusable][aria-modal="true"]'
  )

  // STEP 4: Get all available type filter checkboxes & labels
  const typeOptions = await modal.$$eval(
    'input[type="checkbox"][data-test^="facet-checkbox-"]',
    (checkboxes) =>
      checkboxes.map((cb) => ({
        checked: cb.checked,
        label: cb.parentElement?.nextElementSibling?.innerText?.trim() || "",
        id: cb.id,
      }))
  )

  // Find the checked index
  const prevIndex = typeOptions.findIndex((o) => o.checked)
  if (prevIndex === -1) throw new Error("No type is currently checked")

  // If we're at the last option, close and return
  if (prevIndex + 1 >= typeOptions.length) {
    await modal.$eval(`button[aria-label="close"]`, (el) => el.click())
    return {
      current: typeOptions[prevIndex].label,
      next: false,
    }
  }

  // Uncheck current and check next
  await modal.$eval(`label[for="${typeOptions[prevIndex].id}"]`, (el) =>
    el.click()
  )
  await page.waitForTimeout(250)
  await modal.$eval(`label[for="${typeOptions[prevIndex + 1].id}"]`, (el) =>
    el.click()
  )
  await page.waitForTimeout(250)

  // STEP 5: Click "Apply" to apply the filter
  const applyBtn = await modal.$('button:has-text("Apply")')
  if (applyBtn) await applyBtn.click()

  const seeResultsBtn = await page.$(
    'div[data-floating-ui-portal] button:has-text("See results")'
  )
  if (seeResultsBtn) await seeResultsBtn.click()

  // Wait for the URL to change
  await page.waitForFunction(
    (oldUrl) => window.location.href !== oldUrl,
    {},
    page.url()
  )

  return {
    current: typeOptions[prevIndex + 1].label,
    next: prevIndex + 2 < typeOptions.length,
  }
}
