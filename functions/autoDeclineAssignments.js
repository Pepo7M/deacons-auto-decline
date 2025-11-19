const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const autoDeclineAssignments = functions.https.onRequest(async (req, res) => {
  const now = Date.now();
  console.log("⏱ Running auto-decline check at:", now);

  try {
    const snapshot = await db
        .collection("ServiceAssignments")
        .where("status", "==", "pending")
        .where("expiresAt", "<=", now)
        .get();

    if (snapshot.empty) {
      console.log("👌 No expired invitations found.");
      return res.send("No expired assignments");
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.update(doc.ref, {
        status: "declined",
        respondedAt: now,
        autoDeclined: true,
      });
    });

    await batch.commit();
    console.log(`🚫 Auto-declined ${snapshot.size} expired assignments`);
    res.send(`Auto-declined ${snapshot.size} expired assignments`);
  } catch (error) {
    console.error("🔥 Error auto-declining assignments:", error);
    res.status(500).send("Error auto-declining assignments");
  }
});

module.exports = {autoDeclineAssignments};
