const swaggerAutogen = require("swagger-autogen")();

const doc = {
  info: {
    title: "NightCrawlers API",
    description: "API documentation",
  },
  host: "localhost:5000",
  schemes: ["http"],
};

const outputFile = "./swagger-output.json";

const endpointsFiles = [
  "./app.js",
  "./routes/userAuthRoutes.js",
  "./routes/userRoutes.js",
  "./routes/vendorRoutes.js",
  "./routes/riderRoutes.js",
  "./routes/storeRoutes.js",
  "./routes/menuItemRoutes.js",
  "./routes/orderRoutes.js",
  "./routes/adminRoutes.js",
  "./routes/adminAuthRoutes.js",
  "./routes/phoneVerificationRoutes.js",
  "./routes/earningsRoutes.js"
];

swaggerAutogen(outputFile, endpointsFiles, doc);