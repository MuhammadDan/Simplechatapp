const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Message = sequelize.define(
  "Message",
  {
    username: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    text: {
      type: DataTypes.STRING,
      allowNull: false,
    }
  },
  {
    tableName: "Messages", // explicit name; default pluralization is same
    timestamps: true,      // adds createdAt, updatedAt
  }
);

module.exports = Message;