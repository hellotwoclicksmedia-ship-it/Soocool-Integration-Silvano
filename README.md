# Silvano Integration Service

A Node.js/Express webhook service that connects **Shopify** to **SooCool** for automated delivery order creation and tracking.

## Flows

| Flow | Trigger | What happens |
|---|---|---|
| **Pizza** | Shopify order with `product_type = Pizza` | Delivery-only SooCool order created |
| **Meal** | Shopify order with `product_type = Meal` | Pickup (Italy) + Delivery order created; PDF generated |

## Setup

### 1. Clone & install
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Run locally
```bash
npm run dev
```

### 4. Expose publicly (for webhook testing)
```bash
npx ngrok http 3000
# Use the ngrok URL as WEBHOOK_BASE_URL in .env
```

### 5. Register Shopify webhook
In Shopify Admin → Settings → Notifications → Webhooks:
- Event: **Order creation**
- URL: `https://your-url/webhooks/shopify/orders`
- Format: JSON

## Environment Variables

See `.env.example` for all variables. Key ones:

| Variable | Description |
|---|---|
| `SOOCOOL_API_KEY` | SooCool X-API-Key |
| `SOOCOOL_BASE_URL` | Staging or production API URL |
| `SHOPIFY_STORE_URL` | e.g. `mystore.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Shopify Admin API token |
| `SHOPIFY_WEBHOOK_SECRET` | HMAC secret from Shopify webhook setup |
| `WEBHOOK_BASE_URL` | Public URL of this service (Railway URL) |

## Shopify Product Setup

Set `product_type` on each product in Shopify's product catalog:
- `Pizza` for pizza products
- `Meal` for meal boxes

## Deploy to Railway

1. Push to GitHub
2. Create new Railway project → Deploy from GitHub
3. Add all environment variables in Railway dashboard
4. Railway will auto-assign a public URL — set it as `WEBHOOK_BASE_URL`

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/shopify/orders` | Shopify orders/create webhook |
| `POST` | `/webhooks/soocool/updates` | SooCool task_state updates |
| `GET` | `/health` | Health check |

## Tests

```bash
npm test
```

## Generated PDFs

For Meal flow orders, PDFs are saved to `tmp/labels/order-{number}.pdf`.
SooCool shipping labels are saved to `tmp/labels/label-{number}.pdf`.

> **Note:** Railway's filesystem is ephemeral. In a future phase, PDFs will be emailed or stored in cloud storage.
