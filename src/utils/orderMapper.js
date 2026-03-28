'use strict';
const config = require('../config');

/**
 * Returns the correct UTC offset for the Netherlands on a given date.
 * CET  = +01:00 (last Sunday of October → last Sunday of March)
 * CEST = +02:00 (last Sunday of March  → last Sunday of October)
 *
 * EU DST rules: clocks spring forward on the last Sunday of March at 02:00 local,
 *               and fall back on the last Sunday of October at 03:00 local.
 *
 * @param {string} datePart - date string in YYYY-MM-DD format
 * @returns {string} "+01:00" or "+02:00"
 */
function getNlOffset(datePart) {
    const [y, m, d] = datePart.split('-').map(Number);

    // Last Sunday of a given month
    function lastSunday(year, month) {
        // day 0 of next month = last day of this month
        const lastDay = new Date(year, month, 0).getDate();
        const dow = new Date(year, month - 1, lastDay).getDay(); // 0=Sun
        return lastDay - dow;
    }

    const marchSwitch = lastSunday(y, 3);  // last Sunday of March
    const octoberSwitch = lastSunday(y, 10); // last Sunday of October

    // CEST runs from last-Sunday-of-March to last-Sunday-of-October (exclusive)
    const isCEST =
        (m > 3 && m < 10) ||                       // Apr–Sep: always CEST
        (m === 3 && d >= marchSwitch) ||             // March: on or after switch day
        (m === 10 && d < octoberSwitch);             // October: before switch day

    return isCEST ? '+02:00' : '+01:00';
}

/**
 * Parses Shopify order note_attributes into a SooCool-compatible time window.
 *
 * Expects note_attributes entries:
 *   { name: 'Delivery-Date', value: '2026/02/28' }
 *   { name: 'Delivery-Time', value: '8:00 AM - 6:00 PM' }  (optional if shippingLines provided)
 *
 * If Delivery-Time is missing, falls back to parsing the time from
 * the shipping line title (e.g. "Afternoon Delivery 1PM to 6PM").
 *
 * @param {Array} noteAttributes
 * @param {Array} [shippingLines] - order.shipping_lines from Shopify (optional fallback)
 * @returns {{ startTime: string, endTime: string }} ISO 8601 datetime strings
 */
function parseDeliveryWindow(noteAttributes, shippingLines) {
    const attrs = {};
    for (const attr of (noteAttributes || [])) {
        attrs[attr.name] = attr.value;
    }

    const dateStr = attrs['Delivery-Date']; // e.g. "2026/02/28"
    if (!dateStr) {
        throw new Error(`Missing Delivery-Date in note_attributes. Got: ${JSON.stringify(attrs)}`);
    }

    // Normalise date: "2026/02/28" → "2026-02-28"
    const datePart = dateStr.replace(/\//g, '-');
    const offset = getNlOffset(datePart);

    // ── SooCool agreed time window: always 08:00–18:00 ───────────────────
    // The SooCool contract only allows the 08:00–18:00 delivery window.
    // Regardless of what Shopify shipping option the customer selects
    // (e.g. "Afternoon Delivery 1PM to 6PM"), we always send the agreed
    // full-day window to SooCool.
    const AGREED_START = '08:00';
    const AGREED_END   = '18:00';

    // Log what the customer selected for debugging
    const timeStr = attrs['Delivery-Time'];
    const shippingTitle = (shippingLines || [])[0]?.title || '';
    if (timeStr) {
        console.log(`[orderMapper] Customer selected Delivery-Time: "${timeStr}" — using agreed SooCool window ${AGREED_START}-${AGREED_END}`);
    } else if (shippingTitle) {
        console.log(`[orderMapper] Shipping line: "${shippingTitle}" — using agreed SooCool window ${AGREED_START}-${AGREED_END}`);
    }

    return {
        startTime: `${datePart}T${AGREED_START}:00${offset}`,
        endTime: `${datePart}T${AGREED_END}:00${offset}`,
    };
}


function to24h(timeStr) {
    // e.g. "8:00 AM" → "08:00", "6:00 PM" → "18:00"
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) throw new Error(`Cannot parse time: "${timeStr}"`);
    let [, h, m, meridiem] = match;
    h = parseInt(h, 10);
    if (meridiem.toUpperCase() === 'PM' && h !== 12) h += 12;
    if (meridiem.toUpperCase() === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
}

/**
 * Converts a bare hour + meridiem (e.g. "1PM", "12AM") to 24-hour HH:MM.
 */
function bareHourTo24h(hourStr, meridiem) {
    let h = parseInt(hourStr, 10);
    const m = meridiem.toUpperCase();
    if (m === 'PM' && h !== 12) h += 12;
    if (m === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:00`;
}

/**
 * Extracts a start/end time window from a Shopify shipping line title.
 *
 * Handles a wide variety of formats found in shipping rate names:
 *   "Afternoon Delivery 1PM to 6PM"
 *   "Morning Delivery 8AM - 12PM"
 *   "Evening 6:00 PM - 9:00 PM"
 *   "Delivery 08:00-18:00"
 *   "Same Day 1 PM to 6 PM"
 *   "Next Day 8:00AM-6:00PM"
 *
 * @param {string} title - shipping line title
 * @returns {{ startTime24h: string, endTime24h: string } | null}
 */
function parseTimeFromShippingTitle(title) {
    if (!title) return null;

    // Pattern 1: "H:MM AM/PM - H:MM AM/PM" or "H:MM AM/PM to H:MM AM/PM"
    //   e.g. "6:00 PM - 9:00 PM", "8:00AM to 6:00PM"
    let match = title.match(
        /(\d{1,2}):(\d{2})\s*(AM|PM)\s*(?:-|to)\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i
    );
    if (match) {
        const start = to24h(`${match[1]}:${match[2]} ${match[3]}`);
        const end = to24h(`${match[4]}:${match[5]} ${match[6]}`);
        return { startTime24h: start, endTime24h: end };
    }

    // Pattern 2: "HAM/PM to HPM/AM" or "HAM/PM - HPM/AM" (no colon, no space)
    //   e.g. "1PM to 6PM", "8AM-12PM"
    match = title.match(
        /(\d{1,2})\s*(AM|PM)\s*(?:-|to)\s*(\d{1,2})\s*(AM|PM)/i
    );
    if (match) {
        const start = bareHourTo24h(match[1], match[2]);
        const end = bareHourTo24h(match[3], match[4]);
        return { startTime24h: start, endTime24h: end };
    }

    // Pattern 3: "H AM/PM to H AM/PM" (space between hour and meridiem)
    //   e.g. "1 PM to 6 PM", "8 AM - 12 PM"
    match = title.match(
        /(\d{1,2})\s+(AM|PM)\s*(?:-|to)\s*(\d{1,2})\s+(AM|PM)/i
    );
    if (match) {
        const start = bareHourTo24h(match[1], match[2]);
        const end = bareHourTo24h(match[3], match[4]);
        return { startTime24h: start, endTime24h: end };
    }

    // Pattern 4: 24-hour format "HH:MM-HH:MM" or "HH:MM to HH:MM"
    //   e.g. "08:00-18:00", "8:00 to 18:00"
    match = title.match(
        /(\d{1,2}):(\d{2})\s*(?:-|to)\s*(\d{1,2}):(\d{2})(?!\s*[APap])/
    );
    if (match) {
        const sh = String(parseInt(match[1], 10)).padStart(2, '0');
        const eh = String(parseInt(match[3], 10)).padStart(2, '0');
        return { startTime24h: `${sh}:${match[2]}`, endTime24h: `${eh}:${match[4]}` };
    }

    return null;
}

/**
 * Splits a Dutch-style address string into streetName + houseNumber.
 * The suffix (apartment/floor) is joined to the house number with a hyphen,
 * matching the SooCool API example format (e.g. "20-C", "270-3E").
 * Examples:
 *   "Churchill-laan 270 3E" → { streetName: "Churchill-laan", houseNumber: "270-3E" }
 *   "Straat 12"             → { streetName: "Straat", houseNumber: "12" }
 *   "Straat 12A"            → { streetName: "Straat", houseNumber: "12A" }
 */
function splitAddress(address1) {
    const match = (address1 || '').trim().match(/^(.*?)\s+(\d+[A-Za-z]?)\s*(.*)$/);
    if (match) {
        const base = match[2].trim();
        const suffix = match[3].trim();
        return {
            streetName: match[1].trim(),
            houseNumber: suffix ? `${base}-${suffix}` : base,
        };
    }
    return { streetName: (address1 || '').trim(), houseNumber: '' };
}

/**
 * Maps Shopify shipping_address to SooCool address format.
 * SooCool requires houseNumber as a separate field from streetName.
 */
function mapAddress(shippingAddress) {
    const { streetName, houseNumber } = splitAddress(shippingAddress.address1);
    const person = [
        shippingAddress.first_name,
        shippingAddress.last_name,
    ].filter(Boolean).join(' ') || null;
    // If Shopify address2 has extra info (floor, apartment), append it to houseNumber
    const fullHouseNumber = shippingAddress.address2
        ? `${houseNumber}-${shippingAddress.address2}`
        : houseNumber;
    return {
        person,
        street: streetName,
        houseNumber: fullHouseNumber,
        city: shippingAddress.city,
        postCode: (shippingAddress.zip || '').replace(/\s+/g, ''),
        country: shippingAddress.country_code,
    };
}

/**
 * Sanitises a phone/mobile number for SooCool API.
 * Required format: ^[+]?[0-9]{10,15}$ — returns null if invalid/empty.
 */
function sanitisePhone(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/[\s()\-]/g, '');
    return /^[+]?[0-9]{10,15}$/.test(cleaned) ? cleaned : null;
}

/**
 * Strips non-ASCII / accented characters from a string so SooCool doesn't 500.
 * Replaces common European accented chars with ASCII equivalents, then strips the rest.
 */
function sanitiseContents(str) {
    const cleaned = (str || '')
        .replace(/[\u2018\u2019\u0060\u00B4]/g, "'")   // smart quotes → '
        .replace(/[\u201C\u201D]/g, '"')               // smart double quotes → "
        .replace(/[\u2013\u2014]/g, '-')               // em/en dash → -
        .replace(/\u2013|\u2014|\u2026/g, '-')         // ellipsis, dashes
        .normalize('NFD')                              // decompose accents
        .replace(/[\u0300-\u036f]/g, '')               // strip accent marks
        .replace(/[^\x00-\x7F]/g, '');                 // strip remaining non-ASCII

    return cleaned.substring(0, 100).trim();           // SooCool 500s if contents is too long
}

/**
 * Groups line items into physical boxes using product tags.
 *
 * Each product should have a tag like "bundle:Italian Forest bundle 12 box".
 * Items with the same bundle tag are grouped together.
 * If a group has doubled quantities (e.g. qty 4 instead of 2), it means
 * multiple physical boxes of the same type were ordered.
 *
 * @param {Array} lineItems - order.line_items from Shopify
 * @param {Map} tagsMap - productId → tags string (from shopify.getProductTags)
 * @param {number} itemsPerBox - how many total items fit in one box (default 12 for meals)
 * @returns {Array<{ bundleName: string, items: Array, boxCount: number }>}
 */
function groupItemsIntoBoxes(lineItems, tagsMap, itemsPerBox = 12) {
    // Group by bundle tag
    const groups = new Map();

    for (const item of lineItems) {
        const tags = tagsMap.get(item.product_id) || '';
        const bundleTag = tags.split(',').map(t => t.trim()).find(t => t.startsWith('bundle:'));
        const bundleName = bundleTag ? bundleTag.replace('bundle:', '').trim() : 'Unknown Bundle';

        if (!groups.has(bundleName)) {
            groups.set(bundleName, []);
        }
        groups.get(bundleName).push(item);
    }

    // Calculate box count per group
    const result = [];
    for (const [bundleName, items] of groups) {
        const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
        // For a 12-item box with 6 unique products, base qty per product is 2
        // If qty is 4, that means 2 boxes were ordered
        const uniqueProducts = items.length;
        const baseQtyPerProduct = itemsPerBox / uniqueProducts;
        const boxCount = Math.max(1, Math.round(items[0].quantity / baseQtyPerProduct));

        result.push({ bundleName, items, boxCount });
    }

    return result;
}

/**
 * Builds a SooCool order payload for the Pizza flow (delivery-only).
 * Creates one good (box) per quantity unit so qty 2 = 2 goods in SooCool.
 */
function buildPizzaPayload(order, deliveryWindow) {
    const address = mapAddress(order.shipping_address);

    // Build goods array: one good per physical box (quantity unit)
    const goods = [];
    const allGoodIds = [];
    let goodIdCounter = -1;

    for (const item of order.line_items) {
        for (let q = 0; q < item.quantity; q++) {
            goods.push({
                goodId: goodIdCounter,
                packagingType: 'box',
                contents: sanitiseContents(`Pizza #${order.order_number}: ${item.name}`),
                transportRequirements: ['cooled'],
            });
            allGoodIds.push(goodIdCounter);
            goodIdCounter--;
        }
    }

    return {
        orderReference: `SHOPIFY-${order.order_number}`,
        webhook: {
            webhookUrl: `${config.webhookBaseUrl}/webhooks/soocool/updates`,
            webhookUpdates: ['task_state'],
        },
        tasks: [
            {
                taskType: 'delivery',
                timeWindow: deliveryWindow,
                instructions: null,
                address,
                contactInfo: {
                    email: order.email || null,
                    phone: null,
                    mobile: sanitisePhone(order.shipping_address.phone),
                },
                goods: allGoodIds,
            },
        ],
        goods,
    };
}

/**
 * Builds a SooCool order payload for the Meal flow with multiple boxes.
 *
 * Delivery-only — SooCool picks up from their own NL warehouse.
 * The shipping label from SooCool is sent to the Italy warehouse,
 * who ships the box to SooCool's NL warehouse using that label.
 * SooCool then delivers to the customer (NL/BE address).
 *
 * @param {Object} order - Shopify order object
 * @param {Object} deliveryWindow - parsed delivery window
 * @param {Array} boxGroups - from groupItemsIntoBoxes()
 */
function buildMealPayload(order, deliveryWindow, boxGroups) {
    const customerAddress = mapAddress(order.shipping_address);

    // If no boxGroups provided, fall back to single-box behaviour
    if (!boxGroups || boxGroups.length === 0) {
        const contents = sanitiseContents(order.line_items.map((i) => `${i.name} x${i.quantity}`).join(', '));
        boxGroups = [{ bundleName: 'Meal Box', items: order.line_items, boxCount: 1 }];
    }

    // Build goods array: one good per physical box
    const goods = [];
    const allGoodIds = [];
    let goodIdCounter = -1;

    for (const group of boxGroups) {
        // Calculate total weight for one box (in grams)
        // Shopify stores weight in grams by default
        const totalGroupWeightGrams = group.items.reduce((sum, item) => {
            const itemWeight = item.grams || 0; // Shopify line_items have a 'grams' field
            return sum + (itemWeight * item.quantity);
        }, 0);
        const weightPerBoxGrams = Math.round(totalGroupWeightGrams / group.boxCount);

        for (let b = 0; b < group.boxCount; b++) {
            const good = {
                goodId: goodIdCounter,
                packagingType: 'box',
                contents: sanitiseContents(group.bundleName),
                transportRequirements: ['cooled'],
            };
            // SooCool requires weight as integer >= 1 (grams), omit if 0
            if (weightPerBoxGrams > 0) {
                good.weight = weightPerBoxGrams;
            }
            goods.push(good);
            allGoodIds.push(goodIdCounter);
            goodIdCounter--;
        }
    }

    return {
        orderReference: `SHOPIFY-${order.order_number}`,
        webhook: {
            webhookUrl: `${config.webhookBaseUrl}/webhooks/soocool/updates`,
            webhookUpdates: ['task_state'],
        },
        tasks: [
            {
                taskType: 'delivery',
                timeWindow: deliveryWindow,
                instructions: null,
                address: customerAddress,
                contactInfo: {
                    email: order.email || null,
                    phone: null,
                    mobile: sanitisePhone(order.shipping_address.phone),
                },
                goods: allGoodIds,
            },
        ],
        goods,
    };
}

module.exports = {
    parseDeliveryWindow,
    parseTimeFromShippingTitle,
    buildPizzaPayload,
    buildMealPayload,
    groupItemsIntoBoxes,
    mapAddress,
};
