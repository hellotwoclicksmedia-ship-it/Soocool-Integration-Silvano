'use strict';
const axios = require('axios');
const config = require('../config');

const client = axios.create({
    baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
    headers: {
        'X-Shopify-Access-Token': config.shopify.accessToken,
        'Content-Type': 'application/json',
    },
    timeout: 15000,
});

client.interceptors.response.use(
    (res) => res,
    (err) => {
        console.error('[shopify] API error', {
            status: err.response?.status,
            url: err.config?.url,
            errors: err.response?.data?.errors || err.message,
        });
        return Promise.reject(err);
    }
);

/**
 * Mark a Shopify order as fulfilled with a tracking link.
 */
async function fulfillOrder(shopifyOrderId, trackingUrl, trackingNumber) {
    // Step 1: get fulfillment order id
    const foRes = await client.get(`/orders/${shopifyOrderId}/fulfillment_orders.json`);
    const fulfillmentOrders = foRes.data.fulfillment_orders || [];
    const open = fulfillmentOrders.find((fo) => fo.status === 'open');
    if (!open) {
        console.warn(`[shopify] No open fulfillment order for Shopify order ${shopifyOrderId}`);
        return;
    }

    // Step 2: create fulfillment
    await client.post('/fulfillments.json', {
        fulfillment: {
            line_items_by_fulfillment_order: [{ fulfillment_order_id: open.id }],
            tracking_info: {
                number: trackingNumber || '',
                url: trackingUrl || '',
            },
            notify_customer: true,
        },
    });

    console.log(`[shopify] Fulfillment created for order ${shopifyOrderId}`);
}

/**
 * Append a note to a Shopify order.
 */
async function addOrderNote(shopifyOrderId, note) {
    const res = await client.get(`/orders/${shopifyOrderId}.json?fields=note`);
    const existing = res.data.order.note || '';
    const newNote = existing ? `${existing}\n\n${note}` : note;
    await client.put(`/orders/${shopifyOrderId}.json`, {
        order: { id: shopifyOrderId, note: newNote },
    });
    console.log(`[shopify] Note added to order ${shopifyOrderId}`);
}

/**
 * Fetch tags for a list of product IDs. Returns a Map of productId → tags string.
 * Uses individual product fetches (Shopify doesn't allow bulk tag lookup easily).
 */
async function getProductTags(productIds) {
    const tagsMap = new Map();
    const uniqueIds = [...new Set(productIds)];

    for (const pid of uniqueIds) {
        try {
            const res = await client.get(`/products/${pid}.json?fields=id,tags`);
            tagsMap.set(pid, res.data.product.tags || '');
        } catch (err) {
            console.warn(`[shopify] Could not fetch tags for product ${pid}:`, err.message);
            tagsMap.set(pid, '');
        }
    }
    return tagsMap;
}

/**
 * Fetch a single product by ID. Returns the product object.
 */
async function getProductById(productId) {
    const res = await client.get(`/products/${productId}.json?fields=id,title,product_type,tags`);
    return res.data.product;
}

/**
 * Fetch bundle grouping info for an order via GraphQL Admin API.
 *
 * Uses the `lineItemGroup` field on each line item to identify which items
 * belong to which Shopify bundle — no manual product tags needed.
 *
 * @param {number|string} shopifyOrderId - numeric Shopify order ID
 * @returns {Promise<Map<string, { title: string, quantity: number, lineItemIds: string[] }>>}
 *   Map keyed by lineItemGroup GID, or empty Map if no bundles found.
 *   Also attaches a `byLineItemId` Map<lineItemId, groupId> for easy lookup.
 */
async function getOrderBundleGroups(shopifyOrderId) {
    const graphqlUrl = `https://${config.shopify.storeUrl}/admin/api/2024-04/graphql.json`;

    const query = `
        query getOrderBundles($id: ID!) {
            order(id: $id) {
                lineItems(first: 50) {
                    nodes {
                        id
                        title
                        quantity
                        product { id }
                        lineItemGroup {
                            id
                            title
                            quantity
                        }
                    }
                }
            }
        }
    `;

    const res = await axios.post(
        graphqlUrl,
        {
            query,
            variables: { id: `gid://shopify/Order/${shopifyOrderId}` },
        },
        {
            headers: {
                'X-Shopify-Access-Token': config.shopify.accessToken,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        }
    );

    if (res.data.errors) {
        console.error('[shopify] GraphQL errors:', JSON.stringify(res.data.errors));
        throw new Error(`GraphQL error: ${res.data.errors[0]?.message || 'unknown'}`);
    }

    const lineItems = res.data.data?.order?.lineItems?.nodes || [];
    const groups = new Map();        // groupId → { title, quantity, lineItemIds }
    const byLineItemId = new Map();  // lineItemId → groupId

    for (const item of lineItems) {
        if (!item.lineItemGroup) continue;

        const groupId = item.lineItemGroup.id;
        if (!groups.has(groupId)) {
            groups.set(groupId, {
                title: item.lineItemGroup.title,
                quantity: item.lineItemGroup.quantity,
                lineItemIds: [],
            });
        }
        groups.get(groupId).lineItemIds.push(item.id);
        byLineItemId.set(item.id, groupId);
    }

    // Attach the reverse lookup map as a property
    groups.byLineItemId = byLineItemId;

    console.log(`[shopify] GraphQL bundle lookup: ${groups.size} group(s), ${byLineItemId.size} grouped item(s) out of ${lineItems.length} total`);
    return groups;
}

module.exports = { fulfillOrder, addOrderNote, getProductTags, getProductById, getOrderBundleGroups };
