# RentRig Server

REST API for **RentRig**, an equipment rental platform where owners list equipment, customers book and pay for rentals, and admins manage the marketplace.

- **Live URL:** https://your-server.vercel.app
- **Client repository:** https://github.com/mushfiq-2102/B14-A9-client

## Key features

- Better Auth session token verification (`verifyToken`) and role middlewares (`verifyRenter`, `verifyOwner`, `verifyAdmin`)
- Equipment API with server side search, category / rental type / price / availability filters and sorting
- Owner equipment management and admin approval (pending, approved, rejected)
- Favorites per customer
- Booking quote with rental amount calculation and availability check
- Stripe Checkout verification that saves the booking and the transaction in the `payments` collection
- Admin and owner dashboard analytics

## Environment variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Purpose |
| --- | --- |
| `PORT` | Port for local development |
| `DB_USER`, `DB_PASSWORD`, `DB_CLUSTER` | MongoDB Atlas credentials and cluster host |
| `STRIPE_SECRET_KEY` | Stripe secret key |

## npm packages

`express`, `cors`, `dotenv`, `mongodb`, `stripe`

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Vercel

The app exports the Express instance (`export default app`). Add the environment variables above in the Vercel project settings and allow the Vercel IPs in MongoDB Atlas Network Access.
