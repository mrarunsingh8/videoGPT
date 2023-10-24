const Redis = require("ioredis");

const redisClient = new Redis(process.env.REDIS_STRING, {tls: {rejectUnauthorized: false}});

module.exports = redisClient;