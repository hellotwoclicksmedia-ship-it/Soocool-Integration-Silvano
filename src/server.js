'use strict';
const express = require('express');
const config = require('./config');
const shopifyWebhook = require('./webhooks/shopifyWebhook');
const shopifyCancelWebhook = require('./webhooks/shopifyCancelWebhook');
const soocoolWebhook = require('./webhooks/soocoolWebhook');

const app = express();

// Raw body needed for Shopify HMAC verification
app.use('/webhooks/shopify', express.raw({ type: 'application/json' }));
// Normal JSON for SooCool callbacks
app.use('/webhooks/soocool', express.json());

app.use('/webhooks/shopify/orders', shopifyWebhook);
app.use('/webhooks/shopify/orders', shopifyCancelWebhook);
app.use('/webhooks/soocool', soocoolWebhook);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(config.port, () => {
    console.log(`[server] Listening on port ${config.port}`);
});
