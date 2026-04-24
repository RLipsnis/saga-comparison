using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace InventoryService.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.EnsureSchema(
                name: "inventory");

            migrationBuilder.CreateTable(
                name: "IdempotencyRecords",
                schema: "inventory",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Key = table.Column<Guid>(type: "uuid", nullable: false),
                    OperationType = table.Column<string>(type: "text", nullable: false),
                    ResultJson = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IdempotencyRecords", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Products",
                schema: "inventory",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false),
                    Sku = table.Column<string>(type: "text", nullable: false),
                    Price = table.Column<decimal>(type: "numeric(18,2)", precision: 18, scale: 2, nullable: false),
                    StockQuantity = table.Column<int>(type: "integer", nullable: false),
                    ReservedQuantity = table.Column<int>(type: "integer", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Products", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Reservations",
                schema: "inventory",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    OrderId = table.Column<Guid>(type: "uuid", nullable: false),
                    ProductId = table.Column<Guid>(type: "uuid", nullable: false),
                    Quantity = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Reservations", x => x.Id);
                });

            migrationBuilder.InsertData(
                schema: "inventory",
                table: "Products",
                columns: new[] { "Id", "Name", "Price", "ReservedQuantity", "Sku", "StockQuantity" },
                values: new object[,]
                {
                    { new Guid("a1111111-1111-1111-1111-111111111111"), "Wireless Mouse", 29.99m, 0, "WM-001", 100 },
                    { new Guid("a2222222-2222-2222-2222-222222222222"), "Mechanical Keyboard", 89.99m, 0, "MK-001", 100 },
                    { new Guid("a3333333-3333-3333-3333-333333333333"), "USB-C Hub", 49.99m, 0, "UH-001", 100 },
                    { new Guid("a4444444-4444-4444-4444-444444444444"), "Monitor Stand", 39.99m, 0, "MS-001", 100 },
                    { new Guid("a5555555-5555-5555-5555-555555555555"), "Webcam HD", 59.99m, 0, "WC-001", 100 },
                    { new Guid("b1111111-1111-1111-1111-111111111111"), "Gaming Headset", 79.99m, 0, "GH-001", 10 },
                    { new Guid("b2222222-2222-2222-2222-222222222222"), "Ergonomic Chair", 299.99m, 0, "EC-001", 10 },
                    { new Guid("b3333333-3333-3333-3333-333333333333"), "Desk Lamp", 34.99m, 0, "DL-001", 10 },
                    { new Guid("c1111111-1111-1111-1111-111111111111"), "Limited Edition Tablet", 999.99m, 0, "LT-001", 1 },
                    { new Guid("d1111111-1111-1111-1111-111111111111"), "Discontinued Cable", 9.99m, 0, "DC-001", 0 }
                });

            migrationBuilder.CreateIndex(
                name: "IX_IdempotencyRecords_Key_OperationType",
                schema: "inventory",
                table: "IdempotencyRecords",
                columns: new[] { "Key", "OperationType" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "IdempotencyRecords",
                schema: "inventory");

            migrationBuilder.DropTable(
                name: "Products",
                schema: "inventory");

            migrationBuilder.DropTable(
                name: "Reservations",
                schema: "inventory");
        }
    }
}
