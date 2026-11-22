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

// favorites related apis
app.get('/favorites', verifyToken, verifyRenter, async (req, res) => {
    const query = { userId: req.user._id.toString() };
    const result = await favorites.find(query).sort({ createdAt: -1 }).toArray();
    res.send(result);
})

app.post('/favorites', verifyToken, verifyRenter, async (req, res) => {
    const userId = req.user._id.toString();
    const id = toObjectId(req.body.equipmentId);
    const item = id && await equipment.findOne({ _id: id, status: 'approved' });
    if (!item) {
        return res.status(404).send({ message: 'Not found' });
    }
    const existing = await favorites.findOne({ userId, equipmentId: req.body.equipmentId });
    if (existing) {
        return res.send({ message: 'Already in favorites' });
    }
    // snapshot of the equipment so the favorites table needs no joins
    const favorite = {
        userId,
        equipmentId: req.body.equipmentId,
        name: item.name,
        image: item.image,
        category: item.category,
        rentalPrice: item.rentalPrice,
        rentalType: item.rentalType,
        location: item.location,
        createdAt: new Date(),
    };
    const result = await favorites.insertOne(favorite);
    res.send(result);
})

app.delete('/favorites/:equipmentId', verifyToken, verifyRenter, async (req, res) => {
    const query = { userId: req.user._id.toString(), equipmentId: req.params.equipmentId };
    const result = await favorites.deleteOne(query);
    res.send(result);
})

// bookings related apis
const DAY = 24 * 60 * 60 * 1000;
const UNIT_DAYS = { daily: 1, weekly: 7, monthly: 30 };

// total = rental units (days / weeks / months, rounded up) x price x quantity
const calculateRental = (item, startDate, endDate, quantity) => {
    const days = Math.floor((new Date(endDate) - new Date(startDate)) / DAY) + 1;
    const units = Math.ceil(days / UNIT_DAYS[item.rentalType]);
    return { days, units, totalAmount: units * item.rentalPrice * quantity };
};

// quantity still free for the requested dates (confirmed bookings that overlap are subtracted)
const getRemainingQuantity = async (item, startDate, endDate) => {
    const overlapping = await bookings.find({
        equipmentId: item._id.toString(),
        bookingStatus: 'confirmed',
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
    }).toArray();
    const booked = overlapping.reduce((sum, booking) => sum + booking.quantity, 0);
    return item.availableQuantity - booked;
};

// validates the booking request and returns the equipment with the calculated amounts
const buildQuote = async ({ equipmentId, startDate, endDate, quantity }) => {
    const id = toObjectId(equipmentId);
    const item = id && await equipment.findOne({ _id: id, status: 'approved' });
    if (!item) {
        return { error: 'Equipment not found', status: 404 };
    }
    const today = new Date().toISOString().slice(0, 10);
    const validDates = !isNaN(new Date(startDate)) && !isNaN(new Date(endDate)) && startDate >= today && endDate >= startDate;
    if (!validDates) {
        return { error: 'Please select valid rental dates', status: 400 };
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
        return { error: 'Please enter a valid quantity', status: 400 };
    }
    const remaining = await getRemainingQuantity(item, startDate, endDate);
    const rental = calculateRental(item, startDate, endDate, quantity);
    return { item, remaining, available: quantity <= remaining, ...rental };
};

app.get('/bookings/quote', verifyToken, verifyRenter, async (req, res) => {
    const { equipmentId, startDate, endDate } = req.query;
    const quote = await buildQuote({ equipmentId, startDate, endDate, quantity: Number(req.query.quantity) });
    if (quote.error) {
        return res.status(quote.status).send({ message: quote.error });
    }
    const { item, remaining, available, days, units, totalAmount } = quote;
    res.send({
        available,
        remaining,
        days,
        units,
        totalAmount,
        equipmentName: item.name,
        rentalType: item.rentalType,
        rentalPrice: item.rentalPrice,
    });
})

// payments related apis
app.post('/payments/checkout-verify', verifyToken, verifyRenter, async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.send({ success: false, message: 'Session ID is required' });
    }

    const {
        status,
        payment_status,
        customer_email,
        metadata,
        payment_intent,
        amount_total,
        currency,
    } = await stripe.checkout.sessions.retrieve(sessionId);

    // the checkout session must belong to the currently logged in customer
    if (metadata.userId !== req.user._id.toString()) {
        return res.status(403).send({ message: 'Forbidden' });
    }

    if (status === 'complete' && payment_status === 'paid') {

        const sessionQuery = { sessionId };
        const existingPayment = await payments.findOne(sessionQuery);
        if (existingPayment) {
            return res.send({ success: false, message: 'Payment already verified' });
        }

        const id = toObjectId(metadata.equipmentId);
        const item = id && await equipment.findOne({ _id: id });
        if (!item) {
            return res.send({ success: false, message: 'Equipment not found' });
        }

        const payment = {
            sessionId,
            status,
            payment_status,
            customer_email,
            userId: metadata.userId,
            ownerId: item.ownerId,
            equipmentId: metadata.equipmentId,
            transactionId: payment_intent,
            amount: amount_total / 100,
            currency,
            payment_date: new Date(),
        }

        let result;
        try {
            result = await payments.insertOne(payment);
        } catch (err) {
            // the unique sessionId index rejected a duplicate verification
            return res.send({ success: false, message: 'Payment already verified' });
        }

        // create the booking record only after a successful payment
        const booking = {
            equipmentId: metadata.equipmentId,
            equipmentName: item.name,
            equipmentImage: item.image,
            customerId: metadata.userId,
            customerName: req.user.name,
            customerEmail: req.user.email,
            ownerId: item.ownerId,
            ownerName: item.ownerName,
            ownerEmail: item.ownerEmail,
            startDate: metadata.startDate,
            endDate: metadata.endDate,
            quantity: Number(metadata.quantity),
            contactNumber: metadata.contactNumber,
            deliveryAddress: metadata.deliveryAddress,
            notes: metadata.notes,
            totalAmount: amount_total / 100,
            bookingDate: new Date(),
            paymentStatus: 'paid',
            bookingStatus: 'confirmed',
            transactionId: payment_intent,
        };
        const bookingResult = await bookings.insertOne(booking);
        await payments.updateOne(
            { _id: result.insertedId },
            { $set: { bookingId: bookingResult.insertedId.toString() } }
        );

        res.send({ success: true, result, bookingResult });
        return
    }
    res.send({ success: false, message: 'Payment verification failed' });
})

// bookings list and status apis
app.get('/bookings', verifyToken, verifyRenter, async (req, res) => {
    const query = { customerId: req.user._id.toString() };
    const result = await bookings.find(query).sort({ bookingDate: -1 }).toArray();
    res.send(result);
})

app.get('/bookings/owner', verifyToken, verifyOwner, async (req, res) => {
    const query = { ownerId: req.user._id.toString() };
    const result = await bookings.find(query).sort({ bookingDate: -1 }).toArray();
    res.send(result);
})

app.get('/bookings/all', verifyToken, verifyAdmin, async (req, res) => {
    const result = await bookings.find({}).sort({ bookingDate: -1 }).toArray();
    res.send(result);
})

app.patch('/bookings/:id/status', verifyToken, verifyOwnerOrAdmin, async (req, res) => {
    const id = toObjectId(req.params.id);
    if (!id || !BOOKING_STATUSES.includes(req.body.status)) {
        return res.status(400).send({ message: 'Invalid request' });
    }
    const query = { _id: id };
    const booking = await bookings.findOne(query);
    if (!booking) {
        return res.status(404).send({ message: 'Not found' });
    }
    if (req.user.role !== 'admin' && booking.ownerId !== req.user._id.toString()) {
        return res.status(403).send({ message: 'Forbidden' });
    }
    const updatedDoc = {
        $set: {
            bookingStatus: req.body.status,
        }
    }
    const result = await bookings.updateOne(query, updatedDoc);
    res.send(result);
})

