import { Router } from "express";
import { 
  getProviders, 
  createProvider, 
  getProviderHistory 
} from "../controllers/providers.controller.js";

const router = Router();

router.get("/providers", getProviders);
router.post("/providers", createProvider);
router.get("/providers/:id/history", getProviderHistory);

export default router;