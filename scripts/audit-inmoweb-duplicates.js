// Render Shell: node scripts/audit-inmoweb-duplicates.js <ObjectId del titular>
import mongoose from "mongoose";
import Usuario from "../models/Usuario.js";
import Propiedad from "../models/Propiedad.js";
import ImportSource from "../models/ImportSource.js";
import ImportSyncRun from "../models/ImportSyncRun.js";
import ProviderSnapshot from "../models/ProviderSnapshot.js";
import CrmDelegation from "../models/CrmDelegation.js";
import { auditInmowebDuplicates } from "../utils/audit/inmowebDuplicateAudit.js";

const id = process.argv[2];
if (process.argv.length !== 3 || !/^[a-f0-9]{24}$/i.test(id)) {
  console.error("Indica el ObjectId verificado del titular.");
  process.exitCode = 2;
} else {
  // Native client: no Mongoose connection, autoCreate, autoIndex or model hooks.
  let client;
  try {
    client = new mongoose.mongo.MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const collection = model => client.db().collection(model.collection.name);
    const result = await auditInmowebDuplicates(new mongoose.Types.ObjectId(id), {
      users: collection(Usuario), sources: collection(ImportSource), grants: collection(CrmDelegation),
      runs: collection(ImportSyncRun), snapshots: collection(ProviderSnapshot), properties: collection(Propiedad)
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.totalNEW === null) process.exitCode = 1;
  } catch {
    console.error("No se pudo completar la lectura.");
    process.exitCode = 1;
  } finally { await client?.close(); }
}
