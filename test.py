import requests
import json
import time
import os
from datetime import datetime
class WenzhouDailyScraper:
    """温州日报数字报采集脚本"""
    
    def __init__(self):
        self.base_url = "https://szb.66wz.com"
        self.api_base = f"{self.base_url}/digitalNewspaper/web"
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://szb.66wz.com/newspaper?mediaKey=wzrb&classify=0&id=1",
            "Accept": "application/json, text/plain, */*"
        })
    
    def get_layouts_by_time(self, media_key="wzrb", date_str=None):
        """
        根据日期获取版面列表
        :param media_key: 报纸标识，wzrb=温州日报
        :param date_str: 日期字符串，格式 YYYY-MM-DD，默认今天
        :return: 版面信息列表
        """
        if date_str is None:
            date_str = datetime.now().strftime("%Y-%m-%d")
        
        url = f"{self.api_base}/layout/findByTime"
        params = {
            "mediaKey": media_key,
            "time": date_str
        }
        try:
            resp = self.session.get(url, params=params, timeout=10)
            data = resp.json()
            print(f"[✓] 获取 {date_str} 版面列表成功，共 {len(data.get('data', []))} 个版面")
            return data
        except Exception as e:
            print(f"[✗] 获取版面列表失败: {e}")
            return None
    
    def get_articles_by_layout(self, layout_id):
        """
        根据版面ID获取文章列表
        :param layout_id: 版面ID
        :return: 文章列表
        """
        url = f"{self.api_base}/article/findByLayout"
        params = {"layoutId": layout_id}
        try:
            resp = self.session.get(url, params=params, timeout=10)
            data = resp.json()
            articles = data.get("data", [])
            print(f"  [✓] 版面 {layout_id} 共 {len(articles)} 篇文章")
            return articles
        except Exception as e:
            print(f"  [✗] 获取版面 {layout_id} 文章失败: {e}")
            return []
    
    def get_article_detail(self, article_id):
        """
        获取文章详情
        :param article_id: 文章ID
        :return: 文章详情
        """
        url = f"{self.api_base}/article/findById"
        params = {"id": article_id}
        try:
            resp = self.session.get(url, params=params, timeout=10)
            data = resp.json()
            return data.get("data", {})
        except Exception as e:
            print(f"    [✗] 获取文章 {article_id} 详情失败: {e}")
            return {}
    
    def get_all_digital_paths(self, media_key="wzrb"):
        """
        获取所有数字报路径信息
        """
        url = f"{self.api_base}/layout/findAllDigitalPaths"
        params = {"mediaKey": media_key}
        try:
            resp = self.session.get(url, params=params, timeout=10)
            data = resp.json()
            return data
        except Exception as e:
            print(f"[✗] 获取路径信息失败: {e}")
            return None
    
    def scrape_date(self, date_str=None, media_key="wzrb", save_dir="./wenzhou_daily"):
        """
        采集指定日期的所有文章
        :param date_str: 日期，格式 YYYY-MM-DD
        :param media_key: 报纸标识
        :param save_dir: 保存目录
        """
        if date_str is None:
            date_str = datetime.now().strftime("%Y-%m-%d")
        
        print(f"\n{'='*60}")
        print(f"开始采集温州日报 {date_str}")
        print(f"{'='*60}")
        
        # 1. 获取版面列表
        layouts_data = self.get_layouts_by_time(media_key, date_str)
        if not layouts_data or "data" not in layouts_data:
            print("未获取到版面数据，请检查日期或报纸标识")
            return
        
        layouts = layouts_data["data"]
        all_articles = []
        
        # 2. 遍历每个版面获取文章
        for layout in layouts:
            layout_id = layout.get("id")
            layout_name = layout.get("name", "未知版面")
            print(f"\n📰 版面: {layout_name} (ID: {layout_id})")
            
            articles = self.get_articles_by_layout(layout_id)
            
            for article in articles:
                article_id = article.get("id")
                title = article.get("title", "无标题")
                print(f"    📄 {title}")
                
                # 获取文章详情
                detail = self.get_article_detail(article_id)
                if detail:
                    article_info = {
                        "date": date_str,
                        "layout_name": layout_name,
                        "layout_id": layout_id,
                        "article_id": article_id,
                        "title": detail.get("title", title),
                        "author": detail.get("author", ""),
                        "content": detail.get("content", ""),
                        "summary": detail.get("summary", ""),
                    }
                    all_articles.append(article_info)
                
                time.sleep(0.5)  # 控制请求频率
        
        # 3. 保存结果
        os.makedirs(save_dir, exist_ok=True)
        
        # 保存为JSON
        json_path = os.path.join(save_dir, f"wzrb_{date_str}.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(all_articles, f, ensure_ascii=False, indent=2)
        print(f"\n💾 JSON已保存: {json_path}")
        
        # 保存为TXT（方便阅读）
        txt_path = os.path.join(save_dir, f"wzrb_{date_str}.txt")
        with open(txt_path, "w", encoding="utf-8") as f:
            for art in all_articles:
                f.write(f"{'='*50}\n")
                f.write(f"日期: {art['date']}\n")
                f.write(f"版面: {art['layout_name']}\n")
                f.write(f"标题: {art['title']}\n")
                f.write(f"作者: {art['author']}\n")
                f.write(f"{'─'*50}\n")
                f.write(f"{art['content']}\n\n")
        print(f"💾 TXT已保存: {txt_path}")
        
        print(f"\n✅ 采集完成！共 {len(all_articles)} 篇文章")
        return all_articles
    
    def scrape_date_range(self, start_date, end_date, media_key="wzrb"):
        """
        批量采集日期范围内的报纸
        :param start_date: 开始日期 YYYY-MM-DD
        :param end_date: 结束日期 YYYY-MM-DD
        """
        from datetime import timedelta
        
        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
        
        current = start
        while current <= end:
            date_str = current.strftime("%Y-%m-%d")
            self.scrape_date(date_str, media_key)
            current += timedelta(days=1)
            time.sleep(1)  # 日期间隔


if __name__ == "__main__":
    scraper = WenzhouDailyScraper()
    
    # 方式1: 采集今天的报纸
    scraper.scrape_date()
    
    # 方式2: 采集指定日期
    # scraper.scrape_date("2026-07-04")
    
    # 方式3: 批量采集日期范围
    # scraper.scrape_date_range("2026-07-01", "2026-07-04")
    
    # 方式4: 仅获取版面列表
    # layouts = scraper.get_layouts_by_time("wzrb", "2026-07-04")
    # print(json.dumps(layouts, ensure_ascii=False, indent=2))