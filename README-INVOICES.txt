IBuild System - Payments Module Update

What was added:
- payments.html: complete Payments page.
- Payments API in server.js.
- payments_setup.sql.
- invoices_setup.sql now includes the payments table.
- Invoice API now exposes paid_amount and outstanding_amount based on completed payments.
- Invoice status is automatically set to Paid when completed payments reach the invoice total.
- Invoice status returns to Approved if a fully paid invoice is later reduced below the total.
- Existing invoice deletion is protected when payments exist.

Installation:
1. Keep your existing .env file. Do not replace it.
2. Replace the top-level files with the files from this package.
3. Run invoices_setup.sql once in the same MySQL database.
4. Start the server with:
   node server.js
5. Open:
   http://localhost:3000/dashboard
6. Open "المدفوعات" from the sidebar.

Important:
- Do not copy node_modules from this package.
- The payment module uses the existing projects and invoices tables.
