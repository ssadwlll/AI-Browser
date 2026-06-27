// GEO AI发布助手 - 字段写入模块

const GeoFieldWriter = {
  fieldMapping: {
    title: 'news_tnNewsVo_title',
    summary: 'news_clobs_abstract_',
    introduction: 'news_tnNewsVo_zhaiyao',
    keywords: 'news_tnNewsVo_keywords',
    tags: 'news_tnNewsVo_tags',
    authors: 'news_tnNewsVo_keywords4',
    knowledgeCard: 'news_clobs_content6_',
  },
  MAX_DEPTH: 5,

  writeField(fieldType, data) {
    try {
      const fieldId = this.fieldMapping[fieldType];
      if (!fieldId) return false;

      let element = findElementRecursively(document, fieldId, 0, this.MAX_DEPTH);
      if (!element) return false;

      this.setValue(element, data);
      return true;
    } catch (error) {
      console.error('回填失败:', error);
      return false;
    }
  },

  setValue(element, data) {
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea') {
      element.value = data;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (element.isContentEditable) {
      element.textContent = data;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      element.textContent = data;
    }
  }
};
