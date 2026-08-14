IBuild System - Latest Details Update

This version adds:
1. Independent employee detail page: /employee-details?id=ID
2. Independent payment detail page: /payment-details?id=ID
3. Independent project detail page: /project-details?id=ID
4. Independent invoice detail page: /invoice-details?id=ID
5. Employee service duration calculated automatically from hire/joining date.
6. Employee document uploads (residence, Emirates ID, passport, contract, etc.).
7. Payment attachment uploads.
8. Detailed printable reports for payments and employees.
9. Search/filter support in the detailed reports.
10. Fixed audit log JSON display so it no longer shows [object Object].
11. Fixed sidebar logout placement as a separate bottom button.
12. Added direct Details buttons to employee/payment/invoice/project lists.
13. Added safe database migration for document metadata and payment_documents.
14. Preserved the three company accounts:
    Mahmoud = Admin (main controller)
    Amir = Manager
    Ajmal = Accountant

First run on Windows:
- Make sure Node.js LTS is installed.
- Double-click START-WINDOWS.bat.
- If dependencies are missing, the script runs npm install automatically.
- Then open http://localhost:3000

Important:
- The server performs additive database compatibility/migration checks on startup.
- Uploaded files are stored under uploads/employees and uploads/payments.
- Take a database backup before major changes or restore operations.
