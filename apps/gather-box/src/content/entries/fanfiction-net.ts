import { collectFanfictionNetData } from "../collectors/fanfiction-net";
import { installCollector } from "../collector-entry";

installCollector("fanfiction-net", collectFanfictionNetData);
