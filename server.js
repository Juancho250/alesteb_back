process.env.NODE_OPTIONS = "--dns-result-order=ipv4first";
require("dotenv").config();

const pool = require("./config/db");
