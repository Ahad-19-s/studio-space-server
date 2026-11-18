import express from 'express';
import cors from 'cors'
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const app = express();
const PORT = process.env.PORT || 5000;
app.use(express.json())
app.use(cors())

const client = new MongoClient(process.env.MONGO_DB_URI);
export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}
const connectClient = await connectToMongoDB()
const db = connectClient.db("studioSpace")
const categoryData = db.collection("category")
const studiosData = db.collection("cart")
const bookingData = db.collection("booking")
// Saved-studios wishlist: one doc per { email, studioId } pair.
const wishlistData = db.collection("wishlist")

/// verifyToken
const verifyToken = async (req, res, next) => {
    const authHeaders = req.headers.authorization
    if (authHeaders) {
        const token = authHeaders.split(" ")[1]
        const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`))
        const { payload } = await jwtVerify(token, JWKS)
        console.log(payload);
        return next()
    }

    return res.status(401).send({ message: "Un authorized" });

}



app.get('/', (req, res) => {
    res.send('Hello World!');
});


///cetagory
app.get('/cetagory', async (req, res) => {
    const result = await categoryData.find({}).toArray()
    res.send(result)
})


// All Studio Data + Category Filter
app.get('/explore-studios', async (req, res) => {
    const { category } = req.query;

    const filter = {};

    if (category) {
        filter.category = category;
    }

    const result = await studiosData.find(filter).toArray();

    res.send(result);
});

//details 
app.get('/explore-studios/:id', async (req, res) => {
    const { id } = req.params
    const result = await studiosData.findOne({ _id: new ObjectId(id) })
    res.send(result)
})

//add studio
app.post("/add-studio", verifyToken, async (req, res) => {
    const data = req.body
    console.log("add studio verify",data);
    const result = await studiosData.insertOne(data)
    res.send(result)
})

// my listing
app.get("/my-listing/:email", async (req, res) => {
    const email = req.params.email;
    const result = await studiosData.find({ email: email }).toArray()
    res.send(result)

});

app.get("/add-studio", verifyToken, (req, res) => {
    res.status(200).send("Authorized");
});

//edit get data
app.get("/my-listing-edit/:id", async (req, res) => {
    const { id } = req.params;
    const result = await studiosData.findOne({
        _id: new ObjectId(id),
    });

    res.send(result);
});


//boking collectio
app.post("/booking", verifyToken, async (req, res) => {
    const data = req.body;

    const existingBooking = await bookingData.findOne({
        studioId: data.studioId,
        bookingDate: data.bookingDate,
        // Both Pending and Confirmed bookings hold their time slot.
        status: { $in: ["Pending", "Confirmed"] },
        startTime: { $lt: data.endTime },
        endTime: { $gt: data.startTime }
    });

    if (existingBooking) {
        return res.status(409).send({
            message: "This studio is already booked for this time!"
        });
    }

    const result = await bookingData.insertOne({
        ...data,
        status: "Pending"
    });

    res.send(result);
});


// Boking get
app.get("/booking/:email", async (req, res) => {
    const email = req.params.email;
    const result = await bookingData.find({ email: email }).toArray()
    res.send(result)

});


app.patch("/bookings/cancel/:id", async (req, res) => {
    const { id } = req.params
    const result = await bookingData.updateOne(
        { _id: new ObjectId(id), status: "Pending" },
        { $set: { status: "Cancelled" } }
    );

    res.send(result);
});

// delete my listing data 
// With ?id=<studioId> only that studio is removed; without it the
// legacy behaviour (first studio of the owner) is kept.
app.delete("/my-listing/:email", verifyToken, async (req, res) => {
    const { email } = req.params
    const { id } = req.query
    const result = id
        ? await studiosData.deleteOne({ _id: new ObjectId(id) })
        : await studiosData.deleteOne({ email: email })
    res.send(result)

})

// ---- Saved-studios wishlist ----
// List the studios a user has saved.
app.get("/wishlist/:email", async (req, res) => {
    const { email } = req.params
    const result = await wishlistData.find({ email: email }).toArray()
    res.send(result)
})

// Add/remove a studio from the wishlist (returns the new saved state).
app.post("/wishlist/toggle", verifyToken, async (req, res) => {
    const { email, studioId } = req.body || {}
    if (!email || !studioId) {
        return res.status(400).send({ message: "Email and studioId are required!" })
    }
    const existing = await wishlistData.findOne({ email: email, studioId: studioId })
    if (existing) {
        await wishlistData.deleteOne({ _id: existing._id })
        return res.send({ saved: false })
    }
    await wishlistData.insertOne({ email: email, studioId: studioId, createdAt: new Date() })
    res.send({ saved: true })
})
//updatedData 
app.patch("/my-listing-update/:id", async (req, res) => {
    const { id } = req.params
    const updatedData = req.body
    const result = await studiosData.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedData }
    )
    res.json(result)


})


app.post('/', (req, res) => {
    res.send("home")

})

app.listen(PORT, () => {
    console.log(`Example app listening on port ${PORT}`);
});
export default app