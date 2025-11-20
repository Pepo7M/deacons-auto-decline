const admin = require("firebase-admin");
const { createClient } = require('@sanity/client');
const serviceAccount = require("./service-account.json");

// Initialize Firestore
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Initialize Sanity
const sanity = createClient({
  projectId: "i6xlhwxc",   // ← replace with your project ID
  dataset: "production",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
  apiVersion: "2023-05-03",
});

async function run() {
  const now = Date.now();
  console.log("🕒 Running auto-decline at:", new Date(now).toISOString());

  const snapshot = await db
    .collection("ServiceAssignments")
    .where("status", "==", "pending")
    .where("expiresAt", "<=", now)
    .get();

  if (snapshot.empty) {
    console.log("👌 No expired assignments.");
    return;
  }

  const batch = db.batch();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const serviceId = data.serviceId; // Sanity service document ID

    // 1️⃣ Firestore update
    batch.update(doc.ref, {
      status: "declined",
      autoDeclined: true,
      respondedAt: now,
    });

    // 2️⃣ Sanity update (option 2)
    if (serviceId) {
      await sanity.patch(serviceId)
        .set({
          noResponse: true,
        })
        .commit();

      console.log(`📝 Updated Sanity service ${serviceId}`);
    } else {
      console.log(`⚠️ No serviceId in Firestore document: ${doc.id}`);
    }
  }

  await batch.commit();
  console.log(`🚫 Auto-declined ${snapshot.size} assignments`);
}

run()
  .then(() => console.log("✔ Done"))
  .catch(err => console.error("🔥 Error:", err));
