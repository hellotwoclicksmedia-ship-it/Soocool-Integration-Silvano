'use strict';
const config = require('../config');
const shopify = require('../shopify/client');

/**
 * Detects the flow type from Shopify order line items.
 * 
 * Detection priority:
 *  1. Check for _Bundle property in line_items (Shopify native bundles → meal)
 *  2. Check product_type from webhook payload
 *  3. Fetch product tags from Shopify API (bundle: prefix → meal)
 *  4. Fetch product_type from Shopify API (pizza check)
 *
 * @param {Array} lineItems - order.line_items from Shopify webhook
 * @returns {Promise<'pizza' | 'meal' | 'unknown'>}
 */
async function detectFlow(lineItems) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
        console.warn('[flowDetector] No line items found');
        return 'unknown';
    }

    // ── Quick check: _Bundle property in REST webhook data ─────────────
    // Shopify native bundles include { name: "_Bundle", value: "..." } in properties
    const hasBundleProperty = lineItems.some(item =>
        (item.properties || []).some(p => p.name === '_Bundle')
    );
    if (hasBundleProperty) {
        console.log('[flowDetector] Detected _Bundle property in line items → meal flow');
        return 'meal';
    }

    const pizzaType = config.productTypes.pizza.toLowerCase();
    const mealType = config.productTypes.meal.toLowerCase();

    // Check if product_type is already available in the payload
    let types = new Set(
        lineItems.map((item) => (item.product_type || '').toLowerCase().trim())
    );

    // If all types are empty, fetch from Shopify API
    if (types.size === 1 && types.has('')) {
        console.log('[flowDetector] product_type empty in webhook, fetching from Shopify API...');
        const productIds = [...new Set(lineItems.map(i => i.product_id))];
        const tagsMap = await shopify.getProductTags(productIds);

        // getProductTags fetches individual products — let's also get product_type
        // We need a separate call; reuse the fetched data approach
        const fetchedTypes = new Set();
        for (const pid of productIds) {
            try {
                // We already have tagsMap; check tags for bundle: prefix → meal
                const tags = tagsMap.get(pid) || '';
                const hasBundleTag = tags.split(',').some(t => t.trim().startsWith('bundle:'));
                if (hasBundleTag) {
                    fetchedTypes.add(mealType);
                }
            } catch (err) {
                console.warn(`[flowDetector] Error checking product ${pid}:`, err.message);
            }
        }

        // If no bundle tags found, check for pizza by fetching product_type directly
        if (fetchedTypes.size === 0) {
            for (const pid of productIds) {
                try {
                    const res = await shopify.getProductById(pid);
                    const pt = (res.product_type || '').toLowerCase().trim();
                    if (pt) fetchedTypes.add(pt);
                } catch (err) {
                    console.warn(`[flowDetector] Error fetching product ${pid}:`, err.message);
                }
            }
        }

        types = fetchedTypes;
        console.log('[flowDetector] Resolved product types:', [...types]);
    }

    const hasPizza = types.has(pizzaType);
    const hasMeal = types.has(mealType);

    if (hasPizza && hasMeal) {
        console.warn('[flowDetector] Mixed product types in order — skipping');
        return 'unknown';
    }
    if (hasPizza) return 'pizza';
    if (hasMeal) return 'meal';

    console.warn('[flowDetector] No recognised product_type found. Types:', [...types]);
    return 'unknown';
}

module.exports = { detectFlow };

