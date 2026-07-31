import {
  ArrowLeft, ArrowRight, BarChart3, Bell, Bot, ClipboardList, Coins, FlaskConical,
  FolderOpen, Globe, Landmark, Link2, Lock, LockOpen, Microscope, Play, Plus, Radio,
  Receipt, Rocket, Search, ShieldCheck, TrendingUp, Trophy, Unplug,
} from 'lucide-react';

/**
 * 화면 전역 아이콘 매핑(SVG). 키는 의미 단위이며, 이 파일이 유일한 매핑 소스다.
 * 서버 fixture(actors.json)의 emoji는 CLI 데모 출력에서 계속 쓰므로 건드리지 않고,
 * 웹에서는 role 키로 아이콘을 찾는다.
 */
const ICONS = {
  'buyer-a': BarChart3,
  'buyer-b': Rocket,
  'buyer-c': FlaskConical,
  seller: Microscope,
  marketplace: Landmark,

  search: Search,
  bell: Bell,
  receipt: Receipt,
  chain: Link2,
  play: Play,
  back: ArrowLeft,
  next: ArrowRight,
  plus: Plus,

  trophy: Trophy,
  coins: Coins,
  trend: TrendingUp,
  bank: Landmark,
  globe: Globe,

  shield: ShieldCheck,
  clipboard: ClipboardList,
  feed: Radio,
  agents: Bot,
  audit: FolderOpen,
  unlock: LockOpen,
  locked: Lock,
  offline: Unplug,
};

export default function Icon({ name, size = 16, className, strokeWidth = 1.9 }) {
  const Glyph = ICONS[name];
  if (!Glyph) return null;
  return <Glyph size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />;
}
