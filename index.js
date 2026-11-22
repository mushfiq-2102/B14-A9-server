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

const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).send({ message: 'Unauthorized' });
        return;
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        res.status(401).send({ message: 'Unauthorized' });
        return;
    }

    const query = { token };
    const session = await sessions.findOne(query);
    if (!session || new Date(session.expiresAt) < new Date()) {
        res.status(401).send({ message: 'Unauthorized' });
        return;
    }

    const userId = session.userId;

    const userQuery = { _id: new ObjectId(userId) };
    const user = await users.findOne(userQuery);
    if (!user) {
        res.status(401).send({ message: 'Unauthorized' });
        return;
    }
    if (user.banned) {
        res.status(403).send({ message: 'Account suspended' });
        return;
    }

    req.user = user;
    next();
}

// must call these middlewares after verifyToken
const verifyRenter = async (req, res, next) => {
    if (req.user.role !== 'customer') {
        res.status(403).send({ message: 'Forbidden' });
        return;
    }
    next();
}

const verifyOwner = async (req, res, next) => {
    if (req.user.role !== 'owner') {
        res.status(403).send({ message: 'Forbidden' });
        return;
    }
    next();
}

const verifyAdmin = async (req, res, next) => {
    if (req.user.role !== 'admin') {
        res.status(403).send({ message: 'Forbidden' });
        return;
    }
    next();
}

const verifyOwnerOrAdmin = async (req, res, next) => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
        res.status(403).send({ message: 'Forbidden' });
        return;
    }
    next();
}

// users related apis
app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
    const cursor = users.find({}).sort({ createdAt: -1 });
    const result = await cursor.toArray();
    res.send(result);
})

app.patch('/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
    const id = toObjectId(req.params.id);
    if (!id || !USER_ROLES.includes(req.body.role)) {
        return res.status(400).send({ message: 'Invalid request' });
    }
    const query = { _id: id };
    const updatedDoc = {
        $set: {
            role: req.body.role,
        }
    }
    const result = await users.updateOne(query, updatedDoc);
    res.send(result);
})

app.patch('/users/:id/status', verifyToken, verifyAdmin, async (req, res) => {
    const id = toObjectId(req.params.id);
    if (!id) {
        return res.status(400).send({ message: 'Invalid request' });
    }
    const query = { _id: id };
    const updatedDoc = {
        $set: {
            banned: Boolean(req.body.banned),
        }
    }
    const result = await users.updateOne(query, updatedDoc);
    res.send(result);
})

// profile apis (every logged in user)
app.get('/profile', verifyToken, async (req, res) => {
    const { _id, name, email, image, role, phone, address, createdAt } = req.user;
    res.send({ _id, name, email, image, role, phone, address, createdAt });
})

app.patch('/profile', verifyToken, async (req, res) => {
    const { name, image, phone, address } = req.body;
    const query = { _id: req.user._id };
    const updatedDoc = {
        $set: {
            name,
            image,
            phone,
            address,
            updatedAt: new Date(),
        }
    }
    const result = await users.updateOne(query, updatedDoc);
    res.send(result);
})

// equipment related apis
const SORT_OPTIONS = {
    recent: { createdAt: -1 },
    'price-asc': { rentalPrice: 1 },
    'price-desc': { rentalPrice: -1 },
};

// public: approved equipment with server side search, filter and sort
app.get('/equipment', async (req, res) => {
    const query = { status: 'approved' };

    if (req.query.category) {
        query.category = req.query.category;
    }
    if (req.query.rentalType) {
        query.rentalType = req.query.rentalType;
    }
    if (req.query.availability === 'available') {
        query.availableQuantity = { $gt: 0 };
    }
    if (req.query.availability === 'unavailable') {
        query.availableQuantity = { $lte: 0 };
    }
    if (req.query.minPrice || req.query.maxPrice) {
        query.rentalPrice = {};
        if (req.query.minPrice) {
            query.rentalPrice.$gte = Number(req.query.minPrice);
        }
        if (req.query.maxPrice) {
            query.rentalPrice.$lte = Number(req.query.maxPrice);
        }
    }
    if (req.query.search) {
        const pattern = escapeRegex(req.query.search);
        query.$or = [
            { name: { $regex: pattern, $options: 'i' } },
            { location: { $regex: pattern, $options: 'i' } },
            { category: { $regex: pattern, $options: 'i' } },
        ];
    }

    const sort = SORT_OPTIONS[req.query.sort] || SORT_OPTIONS.recent;
    let cursor = equipment.find(query).sort(sort);
    if (req.query.limit) {
        cursor = cursor.limit(Number(req.query.limit));
    }
    const result = await cursor.toArray();
    res.send(result);
})

// owner: only the logged in owner's equipment
app.get('/equipment/owner', verifyToken, verifyOwner, async (req, res) => {
    const query = { ownerId: req.user._id.toString() };
    const result = await equipment.find(query).sort({ createdAt: -1 }).toArray();
    res.send(result);
})

// admin: every equipment in any status
app.get('/equipment/all', verifyToken, verifyAdmin, async (req, res) => {
    const result = await equipment.find({}).sort({ createdAt: -1 }).toArray();
    res.send(result);
})

// keep only the fields a client is allowed to send
const pickEquipmentFields = (body) => ({
    name: body.name,
    description: body.description,
    category: body.category,
    location: body.location,
    rentalPrice: Number(body.rentalPrice),
    rentalType: body.rentalType,
    availableQuantity: Number(body.availableQuantity),
    condition: body.condition,
    brand: body.brand,
    model: body.model,
    image: body.image,
    rentalTerms: body.rentalTerms,
});

const isValidEquipment = (data) =>
    data.name &&
    CATEGORIES.includes(data.category) &&
    RENTAL_TYPES.includes(data.rentalType) &&
    data.rentalPrice > 0 &&
    Number.isInteger(data.availableQuantity) &&
    data.availableQuantity >= 0;

app.get('/equipment/:id', verifyToken, async (req, res) => {
    const id = toObjectId(req.params.id);
    if (!id) {
        return res.status(404).send({ message: 'Not found' });
    }
    const result = await equipment.findOne({ _id: id });
    if (!result) {
        return res.status(404).send({ message: 'Not found' });
    }
    // only approved equipment is visible, except to its owner and admins
    const isManager = req.user.role === 'admin' || result.ownerId === req.user._id.toString();
    if (result.status !== 'approved' && !isManager) {
        return res.status(404).send({ message: 'Not found' });
    }
    res.send(result);
})

app.post('/equipment', verifyToken, verifyOwner, async (req, res) => {
    const data = pickEquipmentFields(req.body);
    if (!isValidEquipment(data)) {
        return res.status(400).send({ message: 'Invalid equipment data' });
    }
    const item = {
        ...data,
        status: 'pending',
        ownerId: req.user._id.toString(),
        ownerName: req.user.name,
        ownerEmail: req.user.email,
        ownerPhone: req.user.phone || '',
        createdAt: new Date(),
    };
    const result = await equipment.insertOne(item);
    res.send(result);
})

app.patch('/equipment/:id', verifyToken, verifyOwnerOrAdmin, async (req, res) => {
    const id = toObjectId(req.params.id);
    const data = pickEquipmentFields(req.body);
    if (!id || !isValidEquipment(data)) {
        return res.status(400).send({ message: 'Invalid equipment data' });
    }
    const query = { _id: id };
    const item = await equipment.findOne(query);
    if (!item) {
        return res.status(404).send({ message: 'Not found' });
    }
    if (req.user.role !== 'admin' && item.ownerId !== req.user._id.toString()) {
        return res.status(403).send({ message: 'Forbidden' });
    }
    const updatedDoc = {
        $set: { ...data, updatedAt: new Date() }
    }
    const result = await equipment.updateOne(query, updatedDoc);
    res.send(result);
})

app.patch('/equipment/:id/status', verifyToken, verifyAdmin, async (req, res) => {
    const id = toObjectId(req.params.id);
    if (!id || !EQUIPMENT_STATUSES.includes(req.body.status)) {
        return res.status(400).send({ message: 'Invalid request' });
    }
    const query = { _id: id };
    const updatedDoc = {
        $set: {
            status: req.body.status,
        }
    }
    const result = await equipment.updateOne(query, updatedDoc);
    res.send(result);
})

app.delete('/equipment/:id', verifyToken, verifyOwnerOrAdmin, async (req, res) => {
    const id = toObjectId(req.params.id);
    if (!id) {
        return res.status(400).send({ message: 'Invalid request' });
    }
    const query = { _id: id };
    const item = await equipment.findOne(query);
    if (!item) {
        return res.status(404).send({ message: 'Not found' });
    }
    if (req.user.role !== 'admin' && item.ownerId !== req.user._id.toString()) {
        return res.status(403).send({ message: 'Forbidden' });
    }
    const result = await equipment.deleteOne(query);
    await favorites.deleteMany({ equipmentId: req.params.id });
    res.send(result);
})

