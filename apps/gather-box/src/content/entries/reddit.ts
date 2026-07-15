import { installCollector } from "../collector-entry";
import { collectRedditData } from "../collectors/reddit";

installCollector("reddit", collectRedditData);
