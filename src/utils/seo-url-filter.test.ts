import { describe, it, expect } from 'vitest'
import { isSeoRelevantUrl, isSeoRelevant, SEO_FILTER_CONFIG } from './seo-url-filter'

describe('SEO URL Filter', () => {
  describe('isSeoRelevantUrl', () => {
    // ============================================
    // Real-world tests using https://drlanaferris.com/
    // ============================================
    describe('drlanaferris.com - Real World Examples', () => {
      describe('SEO-relevant pages (should pass)', () => {
        const seoRelevantUrls = [
          // Homepage
          'https://drlanaferris.com/',
          // Main pages
          'https://drlanaferris.com/about-haven-health-and-wellness/',
          'https://drlanaferris.com/dr-lana-ferris-2/',
          'https://drlanaferris.com/payment-and-insurance/',
          'https://drlanaferris.com/services/',
          'https://drlanaferris.com/contact/',
          'https://drlanaferris.com/blogs/',
          // Service pages
          'https://drlanaferris.com/autism-assessments/',
          'https://drlanaferris.com/autism-assessments/what-to-expect/',
          'https://drlanaferris.com/autism-assessments/payment-options/',
          'https://drlanaferris.com/integrative-mental-health-2/',
          'https://drlanaferris.com/medication-management/',
          'https://drlanaferris.com/eating-disorder-treatment/',
          'https://drlanaferris.com/gender-affirming-care/',
          'https://drlanaferris.com/complex-trauma-and-ptsd-support/',
          'https://drlanaferris.com/vitamin-testing-and-injections/',
          'https://drlanaferris.com/conditions-treated/',
          'https://drlanaferris.com/pots-mcas-eds-support/',
          'https://drlanaferris.com/neurodiversity-affirming-care/',
          'https://drlanaferris.com/energetic-medicine/',
          // Legal/Policy pages
          'https://drlanaferris.com/cookie-notice/',
          'https://drlanaferris.com/disclaimer/',
          'https://drlanaferris.com/privacy-policy/',
          'https://drlanaferris.com/terms-of-service/',
          // Category pages (these ARE SEO relevant - /category/ not in excluded list)
          'https://drlanaferris.com/category/adhd/',
          'https://drlanaferris.com/category/anxiety/',
          'https://drlanaferris.com/category/autism/',
          'https://drlanaferris.com/category/mental-health/',
          'https://drlanaferris.com/category/ocd/',
        ]

        it.each(seoRelevantUrls)('should mark %s as SEO-relevant', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(true)
        })
      })

      describe('Non-SEO resources (should be filtered)', () => {
        const nonSeoUrls = [
          // Images from the site
          {
            url: 'https://drlanaferris.com/wp-content/uploads/2025/01/New-Logo.png',
            reason: 'image file',
          },
          {
            url: 'https://drlanaferris.com/wp-content/uploads/2025/02/Relief-804x1024.png',
            reason: 'image file',
          },
          {
            url: 'https://drlanaferris.com/wp-content/uploads/2023/12/Screenshot-5.png',
            reason: 'image file',
          },
          {
            url: 'https://drlanaferris.com/wp-content/uploads/2025/01/cropped-New-Logo.png',
            reason: 'image file',
          },
          // WordPress admin/backend
          {
            url: 'https://drlanaferris.com/wp-admin/',
            reason: 'admin page',
          },
          {
            url: 'https://drlanaferris.com/wp-login.php',
            reason: 'login page',
          },
          {
            url: 'https://drlanaferris.com/wp-json/wp/v2/posts',
            reason: 'API endpoint',
          },
          // Tag and author pages (often thin content)
          {
            url: 'https://drlanaferris.com/tag/mental-health/',
            reason: 'tag page',
          },
          {
            url: 'https://drlanaferris.com/author/admin/',
            reason: 'author page',
          },
          // URLs with tracking parameters
          {
            url: 'https://drlanaferris.com/services/?utm_source=facebook&utm_medium=social',
            reason: 'tracking params',
          },
          {
            url: 'https://drlanaferris.com/contact/?fbclid=IwAR123456789',
            reason: 'Facebook click ID',
          },
          {
            url: 'https://drlanaferris.com/autism-assessments/?gclid=abc123',
            reason: 'Google click ID',
          },
          // Feed URLs
          {
            url: 'https://drlanaferris.com/feed/',
            reason: 'RSS feed',
          },
          {
            url: 'https://drlanaferris.com/blogs/feed/',
            reason: 'RSS feed',
          },
        ]

        it.each(nonSeoUrls)('should filter $url ($reason)', ({ url }) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(false)
        })
      })
    })

    // ============================================
    // File Extension Tests
    // ============================================
    describe('File Extensions', () => {
      describe('Image files', () => {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.avif']

        it.each(imageExtensions)('should filter %s files', (ext) => {
          const result = isSeoRelevantUrl(`https://example.com/images/photo${ext}`)
          expect(result.isRelevant).toBe(false)
          expect(result.reason).toContain(ext)
        })
      })

      describe('Document files', () => {
        const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']

        it.each(docExtensions)('should filter %s files', (ext) => {
          const result = isSeoRelevantUrl(`https://example.com/docs/document${ext}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Media files', () => {
        const mediaExtensions = ['.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm', '.ogg']

        it.each(mediaExtensions)('should filter %s files', (ext) => {
          const result = isSeoRelevantUrl(`https://example.com/media/file${ext}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Code/Data files', () => {
        const codeExtensions = ['.js', '.css', '.json', '.xml', '.yaml', '.yml']

        it.each(codeExtensions)('should filter %s files', (ext) => {
          const result = isSeoRelevantUrl(`https://example.com/assets/file${ext}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Font files', () => {
        const fontExtensions = ['.woff', '.woff2', '.ttf', '.otf', '.eot']

        it.each(fontExtensions)('should filter %s files', (ext) => {
          const result = isSeoRelevantUrl(`https://example.com/fonts/font${ext}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Archive files', () => {
        const archiveExtensions = ['.zip', '.rar', '.tar', '.gz', '.7z']

        it.each(archiveExtensions)('should filter %s files', (ext) => {
          const result = isSeoRelevantUrl(`https://example.com/downloads/file${ext}`)
          expect(result.isRelevant).toBe(false)
        })
      })
    })

    // ============================================
    // Path Pattern Tests
    // ============================================
    describe('Path Patterns', () => {
      describe('Admin/Backend paths', () => {
        const adminPaths = [
          '/wp-admin/',
          '/wp-admin/edit.php',
          '/admin/',
          '/admin/dashboard',
          '/administrator/',
          '/backend/',
          '/dashboard/',
          '/wp-login/',
          '/wp-json/wp/v2/posts',
        ]

        it.each(adminPaths)('should filter %s', (path) => {
          const result = isSeoRelevantUrl(`https://example.com${path}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('User account paths', () => {
        const accountPaths = [
          '/login/',
          '/logout/',
          '/signin/',
          '/signout/',
          '/signup/',
          '/register/',
          '/account/',
          '/my-account/',
          '/profile/',
          '/settings/',
          '/preferences/',
          '/password/',
          '/reset-password/',
          '/forgot-password/',
        ]

        it.each(accountPaths)('should filter %s', (path) => {
          const result = isSeoRelevantUrl(`https://example.com${path}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('E-commerce non-indexable paths', () => {
        const ecommercePaths = [
          '/cart/',
          '/checkout/',
          '/basket/',
          '/wishlist/',
          '/compare/',
          '/add-to-cart/123',
          '/remove-from-cart/456',
          '/order-confirmation/',
          '/order-tracking/',
          '/payment/',
        ]

        it.each(ecommercePaths)('should filter %s', (path) => {
          const result = isSeoRelevantUrl(`https://example.com${path}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Search and filter paths', () => {
        const searchPaths = [
          '/search/',
          '/search/results/',
          '/filter/',
          '/results/',
        ]

        it.each(searchPaths)('should filter %s', (path) => {
          const result = isSeoRelevantUrl(`https://example.com${path}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Feed paths', () => {
        const feedPaths = ['/feed/', '/feed/atom', '/rss/', '/atom/']

        it.each(feedPaths)('should filter %s', (path) => {
          const result = isSeoRelevantUrl(`https://example.com${path}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('API paths', () => {
        const apiPaths = ['/api/v1/users', '/api/posts', '/graphql/', '/rest/products']

        it.each(apiPaths)('should filter %s', (path) => {
          const result = isSeoRelevantUrl(`https://example.com${path}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Tag and author paths', () => {
        const taxonomyPaths = [
          '/tag/seo/',
          '/tags/marketing/',
          '/author/john/',
          '/authors/jane/',
        ]

        it.each(taxonomyPaths)('should filter %s', (path) => {
          const result = isSeoRelevantUrl(`https://example.com${path}`)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('WordPress uploads path', () => {
        it('should filter wp-content/uploads paths', () => {
          const result = isSeoRelevantUrl('https://example.com/wp-content/uploads/2024/image.jpg')
          expect(result.isRelevant).toBe(false)
        })
      })
    })

    // ============================================
    // Query Parameter Tests
    // ============================================
    describe('Query Parameters', () => {
      describe('Pagination parameters', () => {
        const paginationUrls = [
          'https://example.com/blog/?page=2',
          'https://example.com/products/?p=3',
          'https://example.com/articles/?paged=5',
          'https://example.com/news/?pg=10',
          'https://example.com/items/?offset=20',
        ]

        it.each(paginationUrls)('should filter %s', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Sorting/Filtering parameters', () => {
        const sortFilterUrls = [
          'https://example.com/products/?sort=price',
          'https://example.com/items/?sortby=date',
          'https://example.com/list/?order=asc',
          'https://example.com/catalog/?orderby=popularity',
          'https://example.com/shop/?filter=blue',
          'https://example.com/store/?filters=color:red',
        ]

        it.each(sortFilterUrls)('should filter %s', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Session/Tracking parameters', () => {
        const trackingUrls = [
          // UTM parameters
          'https://example.com/page/?utm_source=google',
          'https://example.com/page/?utm_medium=cpc',
          'https://example.com/page/?utm_campaign=spring_sale',
          'https://example.com/page/?utm_term=keyword',
          'https://example.com/page/?utm_content=ad1',
          // Platform click IDs
          'https://example.com/page/?fbclid=IwAR123',
          'https://example.com/page/?gclid=abc123',
          'https://example.com/page/?msclkid=xyz789',
          'https://example.com/page/?dclid=def456',
          // Session IDs
          'https://example.com/page/?sessionid=abc123',
          'https://example.com/page/?session_id=xyz',
          'https://example.com/page/?sid=123',
          'https://example.com/page/?phpsessid=session123',
          // Analytics
          'https://example.com/page/?_ga=1.2.3.4',
          'https://example.com/page/?_gl=abc',
          // Affiliate/Referral
          'https://example.com/page/?ref=partner1',
          'https://example.com/page/?affiliate=aff123',
        ]

        it.each(trackingUrls)('should filter %s', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Search query parameters', () => {
        const searchUrls = [
          'https://example.com/?q=search+term',
          'https://example.com/?s=keyword',
          'https://example.com/?search=product',
          'https://example.com/?query=find+this',
          'https://example.com/?keyword=test',
          'https://example.com/?keywords=multiple+words',
        ]

        it.each(searchUrls)('should filter %s', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Preview/Debug parameters', () => {
        const debugUrls = [
          'https://example.com/post/?preview=true',
          'https://example.com/page/?draft=1',
          'https://example.com/article/?debug=1',
          'https://example.com/item/?test=true',
        ]

        it.each(debugUrls)('should filter %s', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(false)
        })
      })

      describe('Cache-busting parameters', () => {
        const cacheUrls = [
          'https://example.com/page/?t=1234567890',
          'https://example.com/page/?ts=1234567890',
          'https://example.com/page/?timestamp=1234567890',
          'https://example.com/page/?cache=bust',
          'https://example.com/page/?_=1234567890',
        ]

        it.each(cacheUrls)('should filter %s', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(false)
        })
      })
    })

    // ============================================
    // SEO-Relevant URLs (Should Pass)
    // ============================================
    describe('SEO-Relevant URLs', () => {
      describe('Standard page URLs', () => {
        const validUrls = [
          'https://example.com/',
          'https://example.com/about/',
          'https://example.com/about-us/',
          'https://example.com/contact/',
          'https://example.com/services/',
          'https://example.com/products/',
          'https://example.com/blog/',
          'https://example.com/blog/my-first-post/',
          'https://example.com/2024/01/article-title/',
          'https://example.com/category/technology/',
          'https://example.com/product/awesome-widget/',
        ]

        it.each(validUrls)('should allow %s', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(true)
        })
      })

      describe('URLs with allowed query parameters', () => {
        const validUrlsWithParams = [
          'https://example.com/product/widget/?color=blue',
          'https://example.com/article/?id=123',
          'https://example.com/post/?slug=my-post',
          'https://example.com/page/?lang=en',
        ]

        it.each(validUrlsWithParams)('should allow %s', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(true)
        })
      })

      describe('HTML file extensions', () => {
        const htmlUrls = [
          'https://example.com/page.html',
          'https://example.com/article.htm',
          'https://example.com/index.php',
          'https://example.com/page.asp',
          'https://example.com/article.aspx',
        ]

        it.each(htmlUrls)('should allow %s', (url) => {
          const result = isSeoRelevantUrl(url)
          expect(result.isRelevant).toBe(true)
        })
      })
    })

    // ============================================
    // Edge Cases
    // ============================================
    describe('Edge Cases', () => {
      it('should handle invalid URLs gracefully', () => {
        const result = isSeoRelevantUrl('not-a-valid-url')
        expect(result.isRelevant).toBe(false)
        expect(result.reason).toBe('Invalid URL')
      })

      it('should handle empty string', () => {
        const result = isSeoRelevantUrl('')
        expect(result.isRelevant).toBe(false)
        expect(result.reason).toBe('Invalid URL')
      })

      it('should handle URLs with multiple query parameters', () => {
        // Mix of allowed and disallowed
        const result = isSeoRelevantUrl('https://example.com/page/?id=123&utm_source=google')
        expect(result.isRelevant).toBe(false)
      })

      it('should be case-insensitive for extensions', () => {
        expect(isSeoRelevantUrl('https://example.com/image.PNG').isRelevant).toBe(false)
        expect(isSeoRelevantUrl('https://example.com/image.Jpg').isRelevant).toBe(false)
        expect(isSeoRelevantUrl('https://example.com/doc.PDF').isRelevant).toBe(false)
      })

      it('should be case-insensitive for path segments', () => {
        expect(isSeoRelevantUrl('https://example.com/WP-ADMIN/').isRelevant).toBe(false)
        expect(isSeoRelevantUrl('https://example.com/Login/').isRelevant).toBe(false)
        expect(isSeoRelevantUrl('https://example.com/CART/').isRelevant).toBe(false)
        expect(isSeoRelevantUrl('https://example.com/Admin/Dashboard/').isRelevant).toBe(false)
      })

      it('should handle URLs with fragments', () => {
        // Fragments should be ignored, base URL should be evaluated
        const result = isSeoRelevantUrl('https://example.com/page/#section')
        expect(result.isRelevant).toBe(true)
      })

      it('should handle protocol-relative URLs as invalid', () => {
        const result = isSeoRelevantUrl('//example.com/page/')
        expect(result.isRelevant).toBe(false)
      })
    })
  })

  // ============================================
  // isSeoRelevant (boolean version)
  // ============================================
  describe('isSeoRelevant', () => {
    it('should return true for SEO-relevant URLs', () => {
      expect(isSeoRelevant('https://example.com/')).toBe(true)
      expect(isSeoRelevant('https://example.com/about/')).toBe(true)
    })

    it('should return false for non-SEO URLs', () => {
      expect(isSeoRelevant('https://example.com/image.png')).toBe(false)
      expect(isSeoRelevant('https://example.com/wp-admin/')).toBe(false)
      expect(isSeoRelevant('https://example.com/?utm_source=test')).toBe(false)
    })
  })

  // ============================================
  // Configuration Export
  // ============================================
  describe('SEO_FILTER_CONFIG', () => {
    it('should export non-HTML extensions', () => {
      expect(SEO_FILTER_CONFIG.nonHtmlExtensions).toContain('.jpg')
      expect(SEO_FILTER_CONFIG.nonHtmlExtensions).toContain('.pdf')
      expect(SEO_FILTER_CONFIG.nonHtmlExtensions).toContain('.js')
    })

    it('should export excluded path patterns (segments)', () => {
      expect(SEO_FILTER_CONFIG.excludedPathPatterns).toContain('wp-admin')
      expect(SEO_FILTER_CONFIG.excludedPathPatterns).toContain('login')
      expect(SEO_FILTER_CONFIG.excludedPathPatterns).toContain('cart')
    })

    it('should export excluded path substrings', () => {
      expect(SEO_FILTER_CONFIG.excludedPathSubstrings).toContain('/wp-content/uploads')
    })

    it('should export excluded query params', () => {
      expect(SEO_FILTER_CONFIG.excludedQueryParams).toContain('utm_source')
      expect(SEO_FILTER_CONFIG.excludedQueryParams).toContain('page')
      expect(SEO_FILTER_CONFIG.excludedQueryParams).toContain('fbclid')
    })
  })
})
