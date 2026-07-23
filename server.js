const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {

    res.json({
        success: true,
        message: "NovaPay Backend is running 🚀"
    });

});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {

    console.log(`NovaPay Server running on port ${PORT}`);

});