// GEO AI发布助手 - 字段读取模块

const GeoFieldReader = {
  TITLE_INPUT_ID: 'news_tnNewsVo_title',
  CONTENT_TEXTAREA_ID: 'news_clobs_content_',
  MAX_DEPTH: 5,

  async readTitleAndContent() {
    try {
      let title = null;
      let content = null;

      const found = this.searchRecursively(document, 0);
      title = found.title;
      content = found.content;

      if (!content) {
        content = await this.readFromVisualEditor();
      }

      return {
        success: !!(title || content),
        title: title || '',
        content: content || '',
        contentLength: (content || '').replace(/\s/g, '').length
      };
    } catch (error) {
      console.error('读取字段失败:', error);
      return { success: false, title: '', content: '', contentLength: 0 };
    }
  },

  searchRecursively(doc, depth) {
    let result = { title: null, content: null };

    if (depth > this.MAX_DEPTH) return result;

    result.title = this.readFromDocument(doc, this.TITLE_INPUT_ID);
    result.content = this.readFromDocument(doc, this.CONTENT_TEXTAREA_ID);

    if (result.title && result.content) return result;

    try {
      const iframes = doc.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (!iframeDoc) continue;

          const iframeResult = this.searchRecursively(iframeDoc, depth + 1);

          if (!result.title && iframeResult.title) {
            result.title = iframeResult.title;
          }
          if (!result.content && iframeResult.content) {
            result.content = iframeResult.content;
          }

          if (result.title && result.content) return result;
        } catch (e) {
          console.log('无法访问iframe(深度' + depth + '):', e.message);
        }
      }
    } catch (error) {
      console.error('遍历iframe失败:', error);
    }

    return result;
  },

  readFromDocument(doc, elementId) {
    try {
      const element = doc.getElementById(elementId);
      if (!element) return null;
      const tagName = element.tagName.toLowerCase();
      if (tagName === 'input' || tagName === 'textarea') {
        return element.value || '';
      }
      if (element.isContentEditable) {
        return element.textContent || '';
      }
      return element.value || '';
    } catch (error) {
      return null;
    }
  },

  async readFromVisualEditor() {
    try {
      const radio0 = this.findElementById(document, 'editor_case_0');
      const radio1 = this.findElementById(document, 'editor_case_1');

      if (!radio0) {
        console.log('AI发布助手: 未找到editor_case_0 radio');
        return null;
      }

      const wasVisualMode = radio1 ? radio1.checked : false;

      if (!wasVisualMode) {
        console.log('AI发布助手: 当前已是文本模式，textarea应有值');
        return null;
      }

      console.log('AI发布助手: 当前为可视化模式，临时切换到文本模式读取正文');

      radio0.click();

      const content = await this.waitForTextareaContent(3000);

      if (wasVisualMode && radio1) {
        radio1.click();
        console.log('AI发布助手: 已恢复为可视化模式');
      }

      return content;
    } catch (error) {
      console.error('从可视化编辑器读取失败:', error);
      try {
        const radio1 = this.findElementById(document, 'editor_case_1');
        if (radio1 && !radio1.checked) radio1.click();
      } catch (e) {}
      return null;
    }
  },

  waitForTextareaContent(timeout) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = () => {
        const found = this.searchRecursively(document, 0);
        if (found.content && found.content.trim()) {
          resolve(found.content);
          return;
        }
        if (Date.now() - startTime > timeout) {
          console.log('AI发布助手: 等待textarea内容超时');
          resolve(null);
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  },

  findElementById(doc, elementId) {
    const el = doc.getElementById(elementId);
    if (el) return el;

    try {
      const iframes = doc.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (!iframeDoc) continue;
          const found = this.findElementById(iframeDoc, elementId);
          if (found) return found;
        } catch (e) {}
      }
    } catch (e) {}

    return null;
  }
};
