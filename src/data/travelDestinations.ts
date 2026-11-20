/**
 * 旅行目的地库（真实静态数据，2026-11-20）。
 *
 * ★ 诚实边界：这里只放**长期稳定、可核验**的事实——城市、所在区域、最佳月份、
 *   典型景点与当地食物。刻意不写票价、营业时间、排队时长、酒店价格：
 *   这些每天都在变，写进代码就等于让用户拿旧信息做决定。
 *   预算只是「人均每天大致区间」，用于排序参考，不构成报价。
 */

export type TravelInterest = 'food' | 'nature' | 'culture' | 'family' | 'photo';

export interface TravelDestination {
  id: string;
  name: string;
  nameEn: string;
  region: string;
  regionEn: string;
  lat: number;
  lon: number;
  /** 最佳出行月份（1-12） */
  bestMonths: number[];
  interests: TravelInterest[];
  /** 人均每天大致花费（元），区间中值；不是报价 */
  budgetPerDay: number;
  /** 典型景点，行程生成时轮转使用 */
  highlights: string[];
  highlightsEn: string[];
  /** 当地食物，写进每日行程 */
  foods: string[];
  foodsEn: string[];
  /** 一条实用提醒 */
  tip: string;
  tipEn: string;
}

export const TRAVEL_DESTINATIONS: TravelDestination[] = [
  {
    id: 'hangzhou',
    name: '杭州',
    nameEn: 'Hangzhou',
    region: '浙江',
    regionEn: 'Zhejiang',
    lat: 30.2741,
    lon: 120.1551,
    bestMonths: [3, 4, 5, 9, 10, 11],
    interests: ['nature', 'culture', 'photo', 'food'],
    budgetPerDay: 520,
    highlights: ['西湖', '灵隐寺', '龙井村', '西溪湿地', '南宋御街'],
    highlightsEn: ['West Lake', 'Lingyin Temple', 'Longjing Village', 'Xixi Wetland', 'Southern Song Imperial Street'],
    foods: ['片儿川', '西湖醋鱼', '葱包桧'],
    foodsEn: ['Pian Er Chuan noodles', 'West Lake fish', 'Cong Bao Hui'],
    tip: '西湖边步行与骑行都方便，周末景区周边限行，尽量地铁到达。',
    tipEn: 'Walking and cycling around West Lake work well; weekend traffic restrictions apply near the scenic area.'
  },
  {
    id: 'chengdu',
    name: '成都',
    nameEn: 'Chengdu',
    region: '四川',
    regionEn: 'Sichuan',
    lat: 30.5728,
    lon: 104.0668,
    bestMonths: [3, 4, 5, 6, 9, 10, 11],
    interests: ['food', 'culture', 'family'],
    budgetPerDay: 460,
    highlights: ['宽窄巷子', '武侯祠', '成都大熊猫繁育研究基地', '人民公园', '锦里'],
    highlightsEn: ['Kuanzhai Alley', 'Wuhou Shrine', 'Panda Base', "People's Park", 'Jinli'],
    foods: ['火锅', '担担面', '钟水饺'],
    foodsEn: ['Hotpot', 'Dan Dan noodles', 'Zhong dumplings'],
    tip: '熊猫基地上午更活跃，建议开园后尽早到；市区景点之间地铁基本可达。',
    tipEn: 'Pandas are more active in the morning; arrive early. Most downtown sights are metro-accessible.'
  },
  {
    id: 'xian',
    name: '西安',
    nameEn: "Xi'an",
    region: '陕西',
    regionEn: 'Shaanxi',
    lat: 34.3416,
    lon: 108.9398,
    bestMonths: [3, 4, 5, 9, 10, 11],
    interests: ['culture', 'food', 'family'],
    budgetPerDay: 430,
    highlights: ['秦始皇兵马俑', '西安城墙', '大雁塔', '陕西历史博物馆', '回民街'],
    highlightsEn: ['Terracotta Army', 'City Wall', 'Giant Wild Goose Pagoda', 'Shaanxi History Museum', 'Muslim Quarter'],
    foods: ['肉夹馍', '羊肉泡馍', '凉皮'],
    foodsEn: ['Roujiamo', 'Yangrou paomo', 'Liangpi'],
    tip: '陕西历史博物馆需提前预约；兵马俑离市区较远，留出半天交通时间。',
    tipEn: 'Book the Shaanxi History Museum ahead; the Terracotta Army is far from downtown—allow half a day.'
  },
  {
    id: 'xiamen',
    name: '厦门',
    nameEn: 'Xiamen',
    region: '福建',
    regionEn: 'Fujian',
    lat: 24.4798,
    lon: 118.0894,
    bestMonths: [3, 4, 5, 10, 11, 12],
    interests: ['nature', 'photo', 'food', 'family'],
    budgetPerDay: 500,
    highlights: ['鼓浪屿', '环岛路', '曾厝垵', '厦门大学', '南普陀寺'],
    highlightsEn: ['Gulangyu', 'Island Ring Road', 'Zengcuoan', 'Xiamen University', 'Nanputuo Temple'],
    foods: ['沙茶面', '海蛎煎', '花生汤'],
    foodsEn: ['Satay noodles', 'Oyster omelette', 'Peanut soup'],
    tip: '鼓浪屿船票需实名预订；台风季关注停航通知，别把返程排在同一天。',
    tipEn: 'Ferry tickets to Gulangyu require real-name booking; in typhoon season watch for suspensions.'
  },
  {
    id: 'qingdao',
    name: '青岛',
    nameEn: 'Qingdao',
    region: '山东',
    regionEn: 'Shandong',
    lat: 36.0671,
    lon: 120.3826,
    bestMonths: [5, 6, 7, 8, 9, 10],
    interests: ['nature', 'photo', 'food'],
    budgetPerDay: 480,
    highlights: ['栈桥', '八大关', '崂山', '五四广场', '啤酒博物馆'],
    highlightsEn: ['Zhanqiao Pier', 'Badaguan', 'Laoshan', 'May Fourth Square', 'Beer Museum'],
    foods: ['海鲜', '青岛啤酒', '鲅鱼水饺'],
    foodsEn: ['Seafood', 'Tsingtao beer', 'Mackerel dumplings'],
    tip: '海边紫外线强，夏季注意防晒；崂山景区范围大，穿好走的鞋。',
    tipEn: 'Coastal sun is strong in summer; Laoshan covers a large area—wear comfortable shoes.'
  },
  {
    id: 'dali',
    name: '大理',
    nameEn: 'Dali',
    region: '云南',
    regionEn: 'Yunnan',
    lat: 25.6065,
    lon: 100.2676,
    bestMonths: [3, 4, 5, 9, 10, 11],
    interests: ['nature', 'photo', 'culture'],
    budgetPerDay: 420,
    highlights: ['洱海', '大理古城', '苍山', '喜洲古镇', '双廊'],
    highlightsEn: ['Erhai Lake', 'Dali Old Town', 'Cangshan', 'Xizhou', 'Shuanglang'],
    foods: ['饵丝', '乳扇', '酸辣鱼'],
    foodsEn: ['Ersi noodles', 'Rushan cheese', 'Sour-spicy fish'],
    tip: '环洱海骑行注意海拔与日晒；古城与湖区之间打车比公交省时。',
    tipEn: 'Mind altitude and sun when cycling Erhai; taxis are faster than buses between old town and lake.'
  },
  {
    id: 'beijing',
    name: '北京',
    nameEn: 'Beijing',
    region: '北京',
    regionEn: 'Beijing',
    lat: 39.9042,
    lon: 116.4074,
    bestMonths: [4, 5, 9, 10],
    interests: ['culture', 'family', 'photo'],
    budgetPerDay: 560,
    highlights: ['故宫', '八达岭长城', '颐和园', '天坛', '国家博物馆'],
    highlightsEn: ['Forbidden City', 'Badaling Great Wall', 'Summer Palace', 'Temple of Heaven', 'National Museum'],
    foods: ['烤鸭', '炸酱面', '豆汁'],
    foodsEn: ['Peking duck', 'Zhajiang noodles', 'Douzhi'],
    tip: '故宫与国家博物馆都要实名预约，周一多数博物馆闭馆，排行程先避开。',
    tipEn: 'The Forbidden City and National Museum require real-name booking; many museums close on Mondays.'
  },
  {
    id: 'changsha',
    name: '长沙',
    nameEn: 'Changsha',
    region: '湖南',
    regionEn: 'Hunan',
    lat: 28.2282,
    lon: 112.9388,
    bestMonths: [3, 4, 5, 9, 10, 11],
    interests: ['food', 'culture', 'family'],
    budgetPerDay: 380,
    highlights: ['岳麓山', '橘子洲', '湖南省博物馆', '太平老街', '谢子龙影像馆'],
    highlightsEn: ['Yuelu Mountain', 'Orange Isle', 'Hunan Museum', 'Taiping Old Street', 'Xie Zilong Photo Museum'],
    foods: ['臭豆腐', '口味虾', '糖油粑粑'],
    foodsEn: ['Stinky tofu', 'Spicy crayfish', 'Sugar-oil rice cakes'],
    tip: '夜宵是长沙的主场，安排行程时把晚上留给小吃街；橘子洲焰火以官方公告为准。',
    tipEn: 'Nights are the main event in Changsha; check official notices for Orange Isle fireworks.'
  },
  {
    id: 'suzhou',
    name: '苏州',
    nameEn: 'Suzhou',
    region: '江苏',
    regionEn: 'Jiangsu',
    lat: 31.2989,
    lon: 120.5853,
    bestMonths: [3, 4, 5, 9, 10, 11],
    interests: ['culture', 'photo', 'family'],
    budgetPerDay: 450,
    highlights: ['拙政园', '平江路', '虎丘', '苏州博物馆', '山塘街'],
    highlightsEn: ['Humble Administrator Garden', 'Pingjiang Road', 'Tiger Hill', 'Suzhou Museum', 'Shantang Street'],
    foods: ['苏式汤面', '松鼠鳜鱼', '蟹壳黄'],
    foodsEn: ['Suzhou noodles', 'Squirrel fish', 'Crab-shell pastry'],
    tip: '园林早上开门后一小时人最少；苏州博物馆需预约，周一闭馆。',
    tipEn: 'Gardens are quietest in the first hour after opening; book the Suzhou Museum ahead—closed Mondays.'
  },
  {
    id: 'guilin',
    name: '桂林',
    nameEn: 'Guilin',
    region: '广西',
    regionEn: 'Guangxi',
    lat: 25.2736,
    lon: 110.29,
    bestMonths: [4, 5, 6, 7, 8, 9, 10],
    interests: ['nature', 'photo'],
    budgetPerDay: 400,
    highlights: ['漓江', '阳朔西街', '龙脊梯田', '象鼻山', '遇龙河'],
    highlightsEn: ['Li River', 'Yangshuo West Street', 'Longji Terraces', 'Elephant Trunk Hill', 'Yulong River'],
    foods: ['桂林米粉', '啤酒鱼', '油茶'],
    foodsEn: ['Guilin rice noodles', 'Beer fish', 'Oil tea'],
    tip: '漓江精华段建议坐船而非赶路；龙脊梯田离市区远，单独留一天。',
    tipEn: 'Take the boat for the best Li River stretch; Longji Terraces deserve a separate day.'
  }
];
