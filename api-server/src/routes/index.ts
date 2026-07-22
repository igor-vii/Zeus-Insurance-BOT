import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import insuranceRouter from "./insurance.js";
import authRouter from "./auth.js";
import adminRouter from "./admin.js";
import escrowRouter from "./escrow.js";
import x402Router from "./x402.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(insuranceRouter);
router.use("/auth", authRouter);
router.use("/admin", adminRouter);
router.use("/escrow", escrowRouter);
router.use("/x402", x402Router);

export default router;
