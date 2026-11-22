import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(
    `mongodb+srv://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD)}@${process.env.DB_CLUSTER}/`
);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("rentrigdb");
// `user` and `session` are the collections managed by Better Auth on the client
const users = database.collection("user");
const sessions = database.collection("session");
const equipment = database.collection("equipment");
const favorites = database.collection("favorites");
const bookings = database.collection("bookings");
const payments = database.collection("payments");

// one payment record per Stripe checkout session
await payments.createIndex({ sessionId: 1 }, { unique: true });

app.get('/', (req, res) => {
    res.send('rent rig is running')
})

// helpers
const toObjectId = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CATEGORIES = [
    'Construction Equipment',
    'Photography Equipment',
    'Vehicles & Transportation',
    'Agriculture Equipment',
    'Electronics',
    'Event Equipment',
];
const RENTAL_TYPES = ['daily', 'weekly', 'monthly'];
const EQUIPMENT_STATUSES = ['pending', 'approved', 'rejected'];
const BOOKING_STATUSES = ['confirmed', 'completed', 'cancelled'];
const USER_ROLES = ['customer', 'owner', 'admin'];

