import { collectDanbooruData } from "../collectors/danbooru";
import { installCollector } from "../collector-entry";

installCollector("danbooru", collectDanbooruData);
