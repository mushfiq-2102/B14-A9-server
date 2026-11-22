# RentRig Server

REST API for **RentRig**, an equipment rental platform where owners list equipment, customers book and pay for rentals, and admins manage the marketplace.

- **Live URL:** https://your-server.vercel.app
- **Client repository:** https://github.com/mushfiq-2102/B14-A9-client

## Key features

- JWT access token verification (`verifyToken`, tokens are signed by Better Auth and checked with the client's JWKS endpoint using `jose`) and role middlewares (`verifyRenter`, `verifyOwner`, `verifyAdmin`)
- Equipment API with server side search, category / rental type / price / availability filters and sorting
- Owner equipment management and admin approval (pending, approved, rejected)
- Favorites per customer
- Booking quote with rental amount calculation and availability check
- Stripe Checkout verification that saves the booking and the transaction in the `payments` collection
- Admin and owner dashboard analytics
- Pagination for the equipment list and the booking history
- Cron job (`node-cron`, plus a secured endpoint for Vercel Cron) that completes bookings after the rental end date
- Email notifications to the renter and the owner when a booking is completed (`nodemailer`)

## Environment variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Purpose |
| --- | --- |
| `PORT` | Port for local development |
| `DB_USER`, `DB_PASSWORD`, `DB_CLUSTER` | MongoDB Atlas credentials and cluster host |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `CLIENT_URL` | URL of the client app, used to fetch the JWT public keys (`/api/auth/jwks`) |
| `CRON_SECRET` | Secret for `GET /cron/complete-bookings` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Email settings (optional, emails are skipped when empty) |

## npm packages

`express`, `cors`, `dotenv`, `mongodb`, `stripe`, `jose`, `node-cron`, `nodemailer`

## Run locally

```bash
npm install
npm run dev
```

## Deploy to Vercel

The app exports the Express instance (`export default app`). Add the environment variables above in the Vercel project settings and allow all IPs (`0.0.0.0/0`) in MongoDB Atlas Network Access. `vercel.json` registers a daily Vercel Cron that calls `/cron/complete-bookings` (Vercel sends `CRON_SECRET` automatically). Locally, `node-cron` runs the same job every day at midnight.
