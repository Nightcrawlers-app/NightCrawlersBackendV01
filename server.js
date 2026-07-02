require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/dbConfig');
const PORT = process.env.PORT || 5000;

connectDB();


app.listen(PORT, () => { 
    console.log(`We are live on http://localhost:${PORT}`); 
});

module.exports = app; // Export the app for testing purposes