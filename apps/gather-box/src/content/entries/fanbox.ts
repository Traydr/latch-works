import { collectFanboxData } from "../collectors/fanbox";
import { installCollector } from "../collector-entry";

installCollector("fanbox", collectFanboxData);
