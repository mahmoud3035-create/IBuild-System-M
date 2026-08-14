-- IBuild System - Payments Module
-- IMPORTANT: This matches the existing IBuild database schema.
-- Do NOT run the old payment_date/payment_method version.

CREATE TABLE IF NOT EXISTS `payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `project_id` int NOT NULL,
  `invoice_id` int DEFAULT NULL,
  `payment_number` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payment_type` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `period_from` date DEFAULT NULL,
  `period_to` date DEFAULT NULL,
  `amount` decimal(15,2) NOT NULL DEFAULT '0.00',
  `submitted_date` date DEFAULT NULL,
  `approved_date` date DEFAULT NULL,
  `due_date` date DEFAULT NULL,
  `received_date` date DEFAULT NULL,
  `status` enum('Draft','Submitted','Under Review','Certified','Approved','Pending','Paid','Rejected') COLLATE utf8mb4_unicode_ci DEFAULT 'Draft',
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `project_id` (`project_id`),
  KEY `invoice_id` (`invoice_id`),
  CONSTRAINT `payments_ibfk_1` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`),
  CONSTRAINT `payments_ibfk_2` FOREIGN KEY (`invoice_id`) REFERENCES `invoices` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
