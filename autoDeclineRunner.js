const admin = require("firebase-admin");

const serviceAccount = require("./service-account.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

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

  snapshot.docs.forEach(doc => {
    batch.update(doc.ref, {
      status: "declined",
      autoDeclined: true,
      respondedAt: now
    });
  });

  await batch.commit();

  console.log(`🚫 Auto-declined ${snapshot.size} assignments`);
}

run()
  .then(() => console.log("✔ Done"))
  .catch(err => console.error("🔥 Error:", err));
