import { collectKemonoData } from "../collectors/kemono";
import { installCollector } from "../collector-entry";

installCollector("kemono", collectKemonoData);
