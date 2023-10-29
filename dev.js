require("dotenv").config();
const app = require("./app");

app.listen(process.env.NODE_PORT, ()=>{
    console.log(`Server is listen on port ${process.env.NODE_PORT}`);
});

