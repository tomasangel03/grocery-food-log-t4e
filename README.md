# Food Log Web Application

A cloud-hosted, mobile-optimized web application designed to help households track grocery purchases, monitor food consumption, and analyze spending habits to prevent food from running out unexpectedly.

---

## 📌 Problem Statement

Food in the household is being consumed much faster than expected without clarity on who is consuming what or why supplies are running out before the end of the month. 

To solve this, the application provides a centralized log for grocery shopping trips—tracking what was bought, quantities, purchase dates, and consumption dates—alongside a dashboard that delivers actionable household insights.

---

## ✨ Features & Views

### 1. Authentication & Access
* **Google OAuth**: Fast and secure login using Google accounts.

### 2. Main Grocery Food Log & Dashboard
* **Statistics Dashboard**:
  * Total number of grocery trips logged.
  * Date of the last shopping trip with 10+ items.
  * Count of items not yet fully consumed.
  * Total money spent on groceries over the last 30 days.
* **Consumption Progress Bar**: Visual percentage bar for each grocery list showing the ratio of consumed vs. unconsumed items.
* **Shopping Entries Summary**:
  * Store name, entry date, unique list ID.
  * Calculated fields: total unique items, total price, count of consumed items, and days elapsed since purchase.
* **Filtering & Search**:
  * Filter by price (`>`, `>=`, `<`, `<=`).
  * Filter by store name.
  * Filter by consumption status (All, Fully Consumed, Partially Consumed).
* **Drafts System**: Save incomplete shopping lists as drafts and resume editing anytime.

### 3. Shopping Entry & Item Management
* **Flexible Item Table**: Dynamic table pre-populated with 5 rows, with options to add or remove rows as needed.
* **Item-Level Data**:
  * **Name** & **Brand**
  * **Size** (Grams `g` or Milliliters `mL`)
  * **Price** (COP - Colombian Peso)
  * **Store Name** & **Entry Date** (Inherited with single-item edit capability)
  * **Consumed Date** & **Notes**
* **Confirmation & Status Updates**:
  * Re-confirmation pop-ups before finalizing complete lists.
  * Quick "Fully Consumed" button to auto-stamp the consumption date.
  * Admin-only item deletion requiring typed confirmation (`DELETE`).

### 4. User Management & Activity Log
* **Users & Permissions**:
  * Admin management for user roles.
  * User activity trackers (last login, view count, edit count).
* **Recent Activity Audit**:
  * Detailed logs tracking actions (View, Login, Add Food, Complete Food) and resource path changes.
* **Pagination**: Server-side style pagination limiting entries to 20 rows per page across views.

---

## 🗺️ Database Scheme & ERD

The relational database handles users, permissions, grocery shopping trips, and individual food items. 

* **ERD Reference Draft**: [FoodLog ERD Scheme - Google Sheets](https://docs.google.com/spreadsheets/u/1/d/1QATwNsfp3le8vh9a1FAwHzoAVmoFYW3y5SdyL8ow5DY/edit)

---

## 🛠️ Tech Stack & Deployment

* **Frontend**: TypeScript (Mobile-first responsive design)
* **Backend & Database**: Supabase (PostgreSQL / SQL)
* **Hosting Platform**: Vercel
* **Version Control**: GitHub

---

## 🚀 Future Roadmap / Iterations

* **Barcode Scanner Integration**: Scan items via mobile camera to automatically retrieve name, size, and reusable IDs, or register new database entries seamlessly.
* **About Page**: A public page that explains what this project is, why it was created, and who is the sole owner of the project.
* **Registration & Households**:
  * After a person registers and exists in the database, they can create a household or join one with a household code.
  * Access is limited to households the person created (as household admin) or households they have been added to.
  * On creation, the household admin sets the join code, or the app assigns a random code.
  * The creator is a **household admin** for that grocery household. That role is separate from a **platform admin**.
  * A household admin can invite people as members and later upgrade a member to household admin.
  * A person can belong to at most **3 households**. That cap applies both to households they create and households they join.
* **Analytics & Insights Dashboard**: Advanced data visualization module for deeper consumption pattern analysis.
* **Feedback Logs**: A page or pop-up where users leave feedback on the tool.
  * Each entry records the page that needs the change and the name of the person giving the feedback.
  * Feedback is split into good comments and constructive feedback.
  * Entries are saved into a working document so they can be implemented later.
  * Once those changes are implemented, they move to a "done" document. Further feedback starts on a new slate.
