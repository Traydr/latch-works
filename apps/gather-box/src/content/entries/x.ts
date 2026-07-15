import { collectXData } from "../collectors/x";
import { installCollector } from "../collector-entry";

installCollector("x", collectXData);
